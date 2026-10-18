// Tally (read-only): receives figures parsed in the browser from the
// accountant's daily Tally exports, stores them, and sends reminders.
// Nothing here ever connects to Tally itself.
const crypto = require("crypto");
const db = require("./db.js");
const H = { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json", "Access-Control-Allow-Headers": "Content-Type" };
const OK = (o) => ({ statusCode: 200, headers: H, body: JSON.stringify(o) });
const call = async (b) => JSON.parse((await db.handler({ httpMethod: "POST", body: JSON.stringify(b) })).body || "{}");
const kvGet = async (k) => { const r = await call({ action: "getPortfolio", user: "main", key: k }); return r && r.data != null ? r.data : null; };
const kvSet = (k, d) => call({ action: "savePortfolio", user: "main", key: k, data: d });
const hash = (p) => crypto.createHash("sha256").update("rkpin:" + p).digest("hex");
const OWNER_CHAT = "8632288596";
const DEFAULTS = { accountantEmail: "onammadhu@gmail.com", ownerEmail: "onamagarbathi@gmail.com", uploaders: ["main", "maadhu"], company: "", mailFrom: "onammadhu@gmail.com", mailSubject: "backup" };
exports.DEFAULTS = DEFAULTS;

async function settings() { return Object.assign({}, DEFAULTS, (await kvGet("tally_settings")) || {}); }
exports.settings = settings;
async function mail(to, subject, text) {
  try { const m = require("./mail.js"); const r = await m.handler({ httpMethod: "POST", body: JSON.stringify({ to, subject, text }) }); return JSON.parse(r.body || "{}"); }
  catch (e) { return { ok: false, error: String(e) }; }
}
exports.mail = mail;
async function tg(text) {
  const base = process.env.URL || "https://rk-tracker-v2.netlify.app";
  try { await fetch(base + "/.netlify/functions/telegram", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "send", chatIds: [OWNER_CHAT], message: text }) }); } catch (e) {}
}
exports.tg = tg;

function runKey() { return crypto.createHmac("sha256", process.env.SUPABASE_SERVICE_KEY || "").update("tally-run").digest("hex").slice(0, 32); }
exports.runKey = runKey;
// Store parsed Tally figures. kind: vouchers | tb | recv | pay | stock
async function ingest(kind, data, file, by, asof) {
  const now = new Date().toISOString();
  const meta = (await kvGet("tally_meta")) || {};
  if (kind === "vouchers") {
    const cur = (await kvGet("tally_vouchers")) || { list: [] };
    const incoming = (data || []).filter(v => v && v.d);
    // The new export is the complete record for its dates: it replaces what we
    // held for those dates (so edited / deleted vouchers don't linger), after
    // the audit has compared old and new.
    let auditNote = null;
    try { auditNote = await runAudit(cur.list, incoming, meta.vouchers && meta.vouchers.upTo); } catch (e) {}
    const lo = incoming.length ? incoming.reduce((m, v) => (v.d < m ? v.d : m), incoming[0].d) : null;
    const hi = incoming.length ? incoming.reduce((m, v) => (v.d > m ? v.d : m), incoming[0].d) : null;
    const key = (v) => [v.d, v.t, v.n, v.p, Math.round((v.a || 0) * 100)].join("|");
    const map = new Map(cur.list.filter(v => !lo || v.d < lo || v.d > hi).map(v => [key(v), v]));
    incoming.forEach(v => map.set(key(v), v));
    const cutoff = new Date(Date.now() - 400 * 864e5).toISOString().slice(0, 10);
    const list = Array.from(map.values()).filter(v => v.d >= cutoff).sort((a, z) => a.d < z.d ? -1 : 1);
    await kvSet("tally_vouchers", { list });
    meta.vouchers = { at: now, by, count: list.length, upTo: list.length ? list[list.length - 1].d : null, file: file || "" };
  } else if (["tb", "recv", "pay", "stock"].includes(kind)) {
    await kvSet("tally_" + kind, { asof: asof || null, at: now, by, rows: data || [], file: file || "" });
    if (kind === "tb" || kind === "stock") { try { await reportFlags(require("./tally-audit.js").checkSnapshot(kind, data || [], asof || now.slice(0, 10)), "Tally audit check"); } catch (e) {} }
    meta[kind] = { at: now, by, rows: (data || []).length, asof: asof || null, file: file || "" };
  } else return { error: "unknown kind" };
  meta.lastUpload = now; meta.lastBy = by;
  await kvSet("tally_meta", meta);
  return { ok: true, meta };
}
exports.ingest = ingest;

// ---- Audit: flag what an auditor would ask about, email new findings once ----
async function reportFlags(flags, title) {
  const A = require("./tally-audit.js");
  const st = (await kvGet("tally_audit")) || { open: [], reported: [] };
  const known = new Set(st.reported || []);
  const fresh = (flags || []).filter((f) => !known.has(f.key));
  if (!fresh.length) return 0;
  const at = new Date().toISOString();
  fresh.forEach((f) => { f.found = at; f.status = "open"; known.add(f.key); });
  st.open = fresh.concat(st.open || []).slice(0, 3000);
  st.reported = Array.from(known).slice(-8000);
  st.at = at;
  await kvSet("tally_audit", st);
  const s = await settings();
  const high = fresh.filter((f) => f.sev === "high").length;
  try {
    const m = require("./mail.js");
    await m.handler({ httpMethod: "POST", body: JSON.stringify({ to: s.ownerEmail, subject: (title || "Tally audit check") + ": " + fresh.length + " new item(s)" + (high ? " — " + high + " important" : ""), html: A.emailBody(fresh.slice(), "") }) });
  } catch (e) {}
  await tg("🧾 <b>" + (title || "Tally audit check") + "</b> — " + fresh.length + " new item(s)" + (high ? ", " + high + " important" : "") + ":\n" +
    fresh.slice(0, 8).map((f) => "• " + f.kind + ": " + ((f.t || "") + " " + (f.n || "")).trim() + (f.p ? " · " + f.p : "") + " " + (f.d || "")).join("\n") + (fresh.length > 8 ? "\n…" : "") + "\nDetails emailed · https://rk-tracker-v2.netlify.app/tally/");
  return fresh.length;
}
exports.reportFlags = reportFlags;
async function runAudit(prev, incoming, prevUpTo) {
  const A = require("./tally-audit.js"), C = require("./tally-compliance.js");
  const st = (await kvGet("tally_audit")) || { open: [] };
  const gone = new Set((st.open || []).filter((f) => /Deleted/.test(f.kind)).map((f) => (f.t || "") + "#" + (f.n || "")));
  const comp = (await kvGet("tally_compliance")) || {};
  const flags = A.check(prev || [], incoming || [], prevUpTo, { knownGone: gone, filedMonths: C.filedMonths(comp) });
  return reportFlags(flags, "Tally audit check");
}

// ---- Vault: keep every original Tally file, with a preview of what was read ----
const LABELS = { vouchers: "Day Book", tb: "Trial Balance", recv: "Receivables", pay: "Payables", stock: "Stock", bank: "Bank statement" };
// Bank statements: one file of transactions per account, merged across uploads
function bankSummary(bank) {
  const A = (bank && bank.accounts) || {};
  return Object.keys(A).map((name) => { const t = A[name].txns || [];
    return { name, n: t.length, from: t.length ? t[0].d : "", to: t.length ? t[t.length - 1].d : "", closing: t.length ? t[t.length - 1].bal : null,
      inTotal: Math.round(t.reduce((a, x) => a + (x.cr || 0), 0)), outTotal: Math.round(t.reduce((a, x) => a + (x.dr || 0), 0)), updated: A[name].updated }; });
}
exports.bankSummary = bankSummary;
async function vaultAdd(entry) {
  const v = (await kvGet("tally_vault")) || [];
  v.unshift(Object.assign({ id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), at: new Date().toISOString() }, entry));
  await kvSet("tally_vault", v.slice(0, 500));
}
// buf: Buffer of the original file; returns the stored link (or "")
async function vaultSaveFile(name, type, buf, meta) {
  let url = "", note = "";
  try {
    if (buf && buf.length <= 4.3 * 1024 * 1024) {
      const r = await db.storageUpload("tally", { name, type: type || "application/octet-stream", data: buf.toString("base64") });
      url = (r && r.url) || ""; if (!url) note = (r && (r.error || r.detail)) || "not stored";
    } else note = "file too large to keep (over 4 MB)";
  } catch (e) { note = String(e.message || e); }
  const rows = (meta && meta.data) || [];
  await vaultAdd({ name, kind: meta && meta.kind, label: LABELS[meta && meta.kind] || "Unrecognised", rows: (meta && meta.total != null) ? meta.total : rows.length, size: buf ? buf.length : 0,
    by: (meta && meta.by) || "", source: (meta && meta.source) || "upload", from: (meta && meta.from) || "", url, note, preview: rows.slice(0, 40) });
  return url;
}
exports.vaultSaveFile = vaultSaveFile;

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers: H, body: "" };
  let b = {}; try { b = JSON.parse(event.body || "{}"); } catch (e) { return OK({ error: "bad request" }); }
  const s = await settings();
  const user = String(b.user || "main").toLowerCase();
  const pins = (await kvGet("user_pins")) || {};
  if (!pins[user]) return OK({ error: "nopin" });
  if (!b.pin || pins[user] !== hash(String(b.pin))) return OK({ error: "pin" });
  const owner = user === "main";
  if (!owner && !(s.uploaders || []).includes(user)) return OK({ error: "not allowed" });
  try {
    if (b.action === "vaultSave") {   // page upload: keep the original file + what was read
      const f = b.file || {};
      const buf = f.data ? Buffer.from(String(f.data).replace(/^data:[^,]+,/, ""), "base64") : null;
      const url = await vaultSaveFile(String(f.name || "file"), f.type, buf, { kind: b.kind, data: b.preview || [], total: b.total, by: user, source: "upload" });
      return OK({ ok: true, url });
    }
    if (b.action === "vault") {
      if (!owner) return OK({ error: "owner only" });
      return OK({ ok: true, vault: (await kvGet("tally_vault")) || [] });
    }
    if (b.action === "ingest") {
      const r = await ingest(b.kind, b.data, b.file, user, b.asof);
      return OK(r);
    }
    if (b.action === "mailNow") {
      if (!owner) return OK({ error: "owner only" });
      const base = process.env.URL || "https://rk-tracker-v2.netlify.app";
      await fetch(base + "/.netlify/functions/tally-mail-background", { method: "POST", headers: { "Content-Type": "application/json", "x-run-key": runKey() }, body: JSON.stringify({ manual: true, notify: false }) }).catch(() => {});
      return OK({ ok: true, started: true });
    }
    // Maadhu (uploader) may also: add bank statements, see what's due, and mark it done
    if (!owner && !["comp", "compDone", "bankIngest", "exp", "expSave", "expRealise", "expUnrealise", "expAddFromTally"].includes(b.action)) return OK({ error: "owner only" });
    if (b.action === "get") {
      const [meta, tb, recv, pay, stock, vch, lr] = await Promise.all(["tally_meta", "tally_tb", "tally_recv", "tally_pay", "tally_stock", "tally_vouchers", "logistics_v2"].map(kvGet));
      const gm = await kvGet("gmail_oauth"), mlog = (await kvGet("tally_mail_log")) || [], bankAll = await kvGet("tally_bank");
      return OK({ ok: true, bank: bankSummary(bankAll), gmail: gm && gm.refresh ? { email: gm.email || "", at: gm.at } : null, mailLog: mlog.slice(0, 10), settings: s, meta: meta || {}, tb, recv, pay, stock, vouchers: (vch && vch.list) || [], dispatches: ((lr && lr.shipments) || []).filter(x => x.invoiceNo).map(x => ({ customer: x.customer, invoiceNo: x.invoiceNo, date: x.dispatchedOn || x.date, amount: x.invoiceAmount })) });
    }
    // ---------------- Supplier payment planner ----------------
    if (b.action === "plan" || b.action === "planSettings" || b.action === "planSend") {
      if (!owner) return OK({ error: "owner only" });
      const P = require("./tally-payplan.js"), C = require("./tally-compliance.js");
      const td = new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10);
      const ps = (await kvGet("payplan_settings")) || {};
      if (b.action === "planSettings") {
        const n = b.settings || {};
        if (n.tiers) ps.tiers = Object.assign(ps.tiers || {}, n.tiers);
        ["budget", "capPct", "buffer", "goodwillPct"].forEach((k) => { if (n[k] !== undefined) ps[k] = Math.max(0, Number(n[k]) || 0); });
        if (n.stat) ps.stat = Object.assign(ps.stat || {}, n.stat);
        await kvSet("payplan_settings", ps); return OK({ ok: true });
      }
      const [pay, vch, comp, mi, bank, recv] = await Promise.all([kvGet("tally_pay"), kvGet("tally_vouchers"), kvGet("tally_compliance"), kvGet("mail_intel"), kvGet("tally_bank"), kvGet("tally_recv")]);
      const sup = P.suppliers((pay && pay.rows) || [], { tiers: ps.tiers, msme: (comp && comp.msme) || [] }, mi);
      const hist = P.history((vch && vch.list) || [], 90);
      // statutory payments due in the next 10 days (amounts typed in by you / Maadhu)
      const occ = C.occurrences(C.mergeItems(comp && comp.items), td, C.isoAdd(td, 10)).filter((o) => ["gstr3b", "tdspay", "pf", "esi", "pt", "advtax"].includes(o.id) && !((comp && comp.done) || {})[o.key]);
      const statutory = occ.map((o) => ({ key: o.key, name: o.name, due: o.due, period: o.period, amount: Number((ps.stat || {})[o.key]) || 0 }));
      const sug = P.suggestBudget(bank, (recv && recv.rows) || [], statutory, ps);
      const budget = Number(ps.budget) || sug.suggested;
      const statTotal = statutory.reduce((a, x) => a + x.amount, 0);
      const plan = P.buildPlan(sup, hist, Math.max(0, budget - statTotal), { capPct: ps.capPct || 40, goodwillPct: ps.goodwillPct || 5 });
      if (b.action === "plan") return OK({ ok: true, today: td, settings: ps, suggestion: sug, budget, statutory, plan, suppliers: sup.map((x) => ({ party: x.party, tier: x.tier, msme: x.msme, due: Math.round(x.due), oldest: x.oldest, chasing: x.chasing, bills: x.bills.length })).sort((a, b) => b.due - a.due),
        imbalance: P.imbalance(sup, hist), sent: ((await kvGet("payplan_hist")) || []).slice(0, 10), noData: !((pay && pay.rows) || []).length });
      // planSend: the approved list goes to Maadhu (copy to Ravi)
      const lines = (b.lines || []).filter((l) => Number(l.amount) > 0).map((l) => ({ party: String(l.party), amount: Math.round(Number(l.amount)), bills: (l.bills || []).slice(0, 10), reason: String(l.reason || "").slice(0, 160) }));
      const st2 = (b.statutory || []).filter((x) => Number(x.amount) > 0);
      if (!lines.length && !st2.length) return OK({ error: "Nothing to send" });
      const total = lines.reduce((a, l) => a + l.amount, 0) + st2.reduce((a, x) => a + Number(x.amount), 0);
      const inr2 = (n) => "Rs " + Math.round(n).toLocaleString("en-IN");
      const text = "Hello Maadhu,\n\nPlease process these payments this week (approved by Ravi):\n\n" +
        (st2.length ? "STATUTORY\n" + st2.map((x) => "  • " + x.name + " (" + x.period + ") — " + inr2(x.amount) + " — due " + x.due).join("\n") + "\n\n" : "") +
        "SUPPLIERS\n" + lines.map((l) => "  • " + l.party + " — " + inr2(l.amount) + (l.bills.length ? " (bills: " + l.bills.join(", ") + ")" : "")).join("\n") +
        "\n\nTotal: " + inr2(total) + (b.note ? "\n\nNote: " + String(b.note).slice(0, 300) : "") + "\n\nAfter paying, the next Day Book will show them. Thank you.";
      const s2 = await settings();
      await mail(s2.accountantEmail, "Payments to make this week — " + inr2(total), text);
      await mail(s2.ownerEmail, "Payment plan sent to Maadhu — " + inr2(total), text);
      await tg("💸 <b>Payment plan sent to Maadhu</b> — " + inr2(total) + "\n" + lines.slice(0, 10).map((l) => "• " + l.party + " " + inr2(l.amount)).join("\n"));
      const h2 = (await kvGet("payplan_hist")) || [];
      h2.unshift({ at: new Date().toISOString(), total, lines, statutory: st2 });
      await kvSet("payplan_hist", h2.slice(0, 52));
      return OK({ ok: true, total });
    }
    // ---------------- Export register (LUT) ----------------
    if (b.action && b.action.indexOf("exp") === 0) {
      const X = require("./tally-exports.js");
      const td = new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10);
      const reg = (await kvGet("export_register")) || { list: [], settings: {} };
      reg.list = reg.list || [];
      const save = async () => { await kvSet("export_register", reg); };
      const find = (id) => reg.list.find((x) => x.id === id);
      const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
      const docUrl = async (f) => {
        if (!f || !f.data) return "";
        const buf = Buffer.from(String(f.data).replace(/^data:[^,]+,/, ""), "base64");
        if (buf.length > 4.3 * 1024 * 1024) throw new Error("File too large (max 4 MB)");
        const r = await db.storageUpload("tally", { name: String(f.name || "document"), type: f.type || "application/octet-stream", data: buf.toString("base64") });
        return (r && r.url) || "";
      };
      if (b.action === "exp") {
        const st = X.settingsOf(reg);
        const [vch, bank, mi] = await Promise.all([kvGet("tally_vouchers"), kvGet("tally_bank"), kvGet("mail_intel")]);
        const buyers = reg.list.map((x) => (x.buyer || "").toLowerCase().split(" ")[0]).filter((w) => w.length > 3);
        const emails = ((mi && mi.items) || []).filter((m) => m.cat === "export_docs" || (m.cat === "customer_payment" && buyers.some((w) => (m.party + " " + m.summary).toLowerCase().includes(w)))).slice(0, 30);
        return OK({ ok: true, today: td, settings: st, summary: X.summary(reg, td),
          list: reg.list.map((x) => Object.assign({}, x, { s: X.status(x, td, st) })).sort((a, b) => (a.invDate < b.invDate ? 1 : -1)),
          candidates: X.tallyCandidates((vch && vch.list) || [], reg), bank: X.bankSuggestions(bank, reg), emails });
      }
      if (b.action === "expSave") {
        const it = Object.assign({}, b.item || {});
        ["inrValue", "fcAmount"].forEach((k) => { if (it[k] !== undefined) it[k] = Number(it[k]) || 0; });
        const url = await docUrl(b.file);
        let x = it.id && find(it.id);
        if (x) Object.assign(x, it); else { x = Object.assign({ id: newId(), realised: [], files: [], added: new Date().toISOString(), by: user }, it); reg.list.push(x); }
        if (url) (x.files = x.files || []).push({ name: String(b.file.name || "document"), url, at: new Date().toISOString(), by: user });
        await save(); return OK({ ok: true, id: x.id });
      }
      if (b.action === "expAddFromTally") {
        (b.items || []).slice(0, 100).forEach((c) => { if (!reg.list.some((x) => x.invNo === c.invNo)) reg.list.push({ id: newId(), invNo: c.invNo, invDate: c.invDate, buyer: c.buyer, inrValue: Number(c.inrValue) || 0, currency: "", fcAmount: 0, realised: [], files: [], added: new Date().toISOString(), by: user, from: "tally" }); });
        await save(); return OK({ ok: true });
      }
      if (b.action === "expRealise") {
        const x = find(b.id); if (!x) return OK({ error: "not found" });
        (x.realised = x.realised || []).push({ d: String(b.d || td).slice(0, 10), amt: Number(b.amt) || 0, ref: String(b.ref || "").slice(0, 120), key: b.key || "", source: b.key ? "bank" : "manual", by: user });
        if (b.full) x.fullyRealised = true;
        await save(); return OK({ ok: true });
      }
      if (b.action === "expUnrealise") { const x = find(b.id); if (x && x.realised) { x.realised.splice(Number(b.idx), 1); x.fullyRealised = false; } await save(); return OK({ ok: true }); }
      if (!owner) return OK({ error: "owner only" });
      if (b.action === "expDel") { reg.list = reg.list.filter((x) => x.id !== b.id); await save(); return OK({ ok: true }); }
      if (b.action === "expSettings") {
        const n = b.settings || {};
        reg.settings = Object.assign(X.settingsOf(reg), { months: Math.max(1, Math.min(24, Number(n.months) || 9)), lutArn: String(n.lutArn || "").slice(0, 40), lutValidTo: /^\d{4}-\d{2}-\d{2}$/.test(n.lutValidTo || "") ? n.lutValidTo : "",
          buyers: String(n.buyers || "").split("\n").map((x) => x.trim()).filter(Boolean).slice(0, 100) });
        await save(); return OK({ ok: true });
      }
      return OK({ error: "unknown action" });
    }
    // ---------------- Compliance, licences, assets, MSME, bank reconciliation ----------------
    if (b.action === "comp") {
      const C = require("./tally-compliance.js");
      const st = (await kvGet("tally_compliance")) || {};
      const items = C.mergeItems(st.items);
      const td = new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10);
      if (!st.since) { st.since = td; await kvSet("tally_compliance", st); }
      const occ = C.occurrences(items, st.since > C.isoAdd(td, -120) ? st.since : C.isoAdd(td, -120), C.isoAdd(td, 75)).map((x) => Object.assign(x, { done: (st.done || {})[x.key] || null, left: C.days(td, x.due) }));
      if (!owner) return OK({ ok: true, today: td, occ: occ.filter((x) => !x.done && x.left <= 30 && x.who !== "ravi") });
      const [lic, assets, pay, bank, vch] = await Promise.all([kvGet("tally_licences"), kvGet("tally_assets"), kvGet("tally_pay"), kvGet("tally_bank"), kvGet("tally_vouchers")]);
      const recon = {};
      const map = st.reconMap || {};
      Object.keys(map).forEach((acc) => { const A = bank && bank.accounts && bank.accounts[acc]; if (A && map[acc]) recon[acc] = C.reconcile(A.txns, (vch && vch.list) || [], map[acc]); });
      const ledgers = {}; ((vch && vch.list) || []).forEach((v) => (v.le || []).forEach((l) => { if (/bank|\bod\b|\bcc\b|a\/c|account/i.test(l.l) && !/charge|interest|loan/i.test(l.l)) ledgers[l.l] = 1; }));
      return OK({ ok: true, today: td, items, occ, licences: (lic && lic.list) || [], assets: (assets && assets.list) || [], suggestions: C.LICENCE_SUGGESTIONS,
        itRates: C.IT_RATES, coLife: C.CO_LIFE, msme: st.msme || [], msmeDues: C.msmeDues((pay && pay.rows) || [], st.msme || [], td),
        payParties: Array.from(new Set(((pay && pay.rows) || []).map((r) => r.party).filter(Boolean))).sort(),
        reconMap: map, recon, bankAccounts: Object.keys((bank && bank.accounts) || {}), bankLedgers: Object.keys(ledgers).sort(), hasLedgerDetail: ((vch && vch.list) || []).some((v) => v.le) });
    }
    const saveDoc = async (f) => {
      if (!f || !f.data) return "";
      const buf = Buffer.from(String(f.data).replace(/^data:[^,]+,/, ""), "base64");
      if (buf.length > 4.3 * 1024 * 1024) throw new Error("File too large (max 4 MB)");
      const r = await db.storageUpload("tally", { name: String(f.name || "document"), type: f.type || "application/octet-stream", data: buf.toString("base64") });
      return (r && r.url) || "";
    };
    if (b.action === "compDone") {   // owner or Maadhu: mark filed / paid, optionally with the challan or acknowledgement
      const st = (await kvGet("tally_compliance")) || {};
      st.done = st.done || {};
      const url = await saveDoc(b.file);
      st.done[String(b.key)] = { at: new Date().toISOString(), by: user, note: String(b.note || "").slice(0, 200), file: url, fileName: b.file ? String(b.file.name || "") : "" };
      await kvSet("tally_compliance", st);
      if (url) { try { await vaultAdd({ name: (b.file && b.file.name) || "proof", kind: "compliance", label: "Compliance proof", rows: 0, size: 0, by: user, source: "upload", url, note: String(b.key), preview: [] }); } catch (e) {} }
      if (user !== "main") await tg("✅ " + user + " marked done: " + String(b.key).replace("|", " due ") + (b.note ? " — " + b.note : "") + (url ? " (proof uploaded)" : ""));
      return OK({ ok: true });
    }
    if (!owner && ["compUndo", "compItems", "licSave", "licDel", "assetSave", "assetDel", "msmeSave", "reconMap"].includes(b.action)) return OK({ error: "owner only" });
    if (b.action === "compUndo") { const st = (await kvGet("tally_compliance")) || {}; if (st.done) delete st.done[String(b.key)]; await kvSet("tally_compliance", st); return OK({ ok: true }); }
    if (b.action === "compItems") { const st = (await kvGet("tally_compliance")) || {}; st.items = Array.isArray(b.items) ? b.items.slice(0, 80) : st.items; await kvSet("tally_compliance", st); return OK({ ok: true }); }
    if (b.action === "msmeSave") { const st = (await kvGet("tally_compliance")) || {}; st.msme = (Array.isArray(b.names) ? b.names : String(b.names || "").split("\n")).map((x) => String(x).trim()).filter(Boolean).slice(0, 300); await kvSet("tally_compliance", st); return OK({ ok: true, msme: st.msme }); }
    if (b.action === "reconMap") { const st = (await kvGet("tally_compliance")) || {}; st.reconMap = st.reconMap || {}; if (b.ledger) st.reconMap[String(b.account)] = String(b.ledger); else delete st.reconMap[String(b.account)]; await kvSet("tally_compliance", st); return OK({ ok: true }); }
    if (b.action === "licSave" || b.action === "assetSave") {
      const key = b.action === "licSave" ? "tally_licences" : "tally_assets";
      const cur = (await kvGet(key)) || { list: [] };
      const it = Object.assign({}, b.item || {});
      it.id = it.id || Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
      const url = await saveDoc(b.file); if (url) { it.file = url; it.fileName = String(b.file.name || ""); }
      const i = cur.list.findIndex((x) => x.id === it.id);
      if (i >= 0) cur.list[i] = Object.assign({}, cur.list[i], it); else cur.list.push(it);
      await kvSet(key, cur); return OK({ ok: true, list: cur.list });
    }
    if (b.action === "licDel" || b.action === "assetDel") {
      const key = b.action === "licDel" ? "tally_licences" : "tally_assets";
      const cur = (await kvGet(key)) || { list: [] }; cur.list = cur.list.filter((x) => x.id !== b.id); await kvSet(key, cur); return OK({ ok: true, list: cur.list });
    }
    if (b.action === "health") {
      const H = require("./tally-health.js");
      const td = new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10);
      const d = await H.load(kvGet);
      const [adv, hist, mi] = await Promise.all([kvGet("tally_advice"), kvGet("tally_advice_hist"), kvGet("mail_intel")]);
      const MI = require("./mail-intel.js");
      return OK({ ok: true, health: H.compute(d, td, d.settings), settings: d.settings || {}, advice: adv ? { at: adv.at, deep: adv.deep, advice: adv.advice, error: adv.error } : null, hist: (hist || []).slice(0, 30),
        inbox: { at: mi && mi.at, error: mi && mi.error, items: MI.recent(mi, 7).map((x) => Object.assign({}, x, { label: MI.LABEL[x.cat] || x.cat })) } });
    }
    if (b.action === "mailDone") {
      const mi = (await kvGet("mail_intel")) || { items: [] };
      (mi.items || []).forEach((x) => { if (x.id === b.id) x.status = b.status === "open" ? "open" : "done"; });
      await kvSet("mail_intel", mi); return OK({ ok: true });
    }
    if (b.action === "advise") {
      const base = process.env.URL || "https://rk-tracker-v2.netlify.app";
      await fetch(base + "/.netlify/functions/tally-advisor-background", { method: "POST", headers: { "Content-Type": "application/json", "x-run-key": runKey() }, body: JSON.stringify({ deep: !!b.deep, quiet: !!b.quiet }) }).catch(() => {});
      return OK({ ok: true, started: true });
    }
    if (b.action === "healthSettings") {
      const cur = (await kvGet("tally_health_settings")) || {};
      const n = b.settings || {};
      const next = Object.assign(cur, { odLimit: Math.max(0, Number(n.odLimit) || 0), openingStock: Math.max(0, Number(n.openingStock) || 0) });
      await kvSet("tally_health_settings", next); return OK({ ok: true, settings: next });
    }
    if (b.action === "audit") {
      if (!owner) return OK({ error: "owner only" });
      const st = (await kvGet("tally_audit")) || { open: [] };
      return OK({ ok: true, flags: st.open || [], at: st.at || null });
    }
    if (b.action === "auditSet") {
      if (!owner) return OK({ error: "owner only" });
      const st = (await kvGet("tally_audit")) || { open: [] };
      (st.open || []).forEach((f) => { if (f.key === b.key) { f.status = b.status === "open" ? "open" : "reviewed"; f.reviewedAt = new Date().toISOString(); } });
      await kvSet("tally_audit", st); return OK({ ok: true });
    }
    if (b.action === "bankIngest") {   // owner or uploader: add a statement's transactions to an account
      const name = String(b.account || "").trim().slice(0, 60);
      if (!name) return OK({ error: "Give the bank account a name (e.g. Canara OD 1234)" });
      const rows = (Array.isArray(b.rows) ? b.rows : []).filter((r) => r && /^\d{4}-\d{2}-\d{2}$/.test(r.d) && ((+r.dr || 0) || (+r.cr || 0)));
      if (!rows.length) return OK({ error: "No transactions found in that file" });
      const bank = (await kvGet("tally_bank")) || { accounts: {} };
      const acc = bank.accounts[name] || (bank.accounts[name] = { txns: [], files: [] });
      const key = (x) => [x.d, Math.round((+x.dr || 0) * 100), Math.round((+x.cr || 0) * 100), x.bal == null ? "" : Math.round(+x.bal * 100), String(x.desc || "").slice(0, 40).toLowerCase()].join("|");
      const have = new Set(acc.txns.map(key)); let added = 0;
      rows.forEach((r, i) => { const x = { d: r.d, desc: String(r.desc || "").slice(0, 200), ref: String(r.ref || "").slice(0, 60), dr: Math.round((+r.dr || 0) * 100) / 100,
        cr: Math.round((+r.cr || 0) * 100) / 100, bal: r.bal == null || r.bal === "" ? null : Math.round(+r.bal * 100) / 100, o: i };
        const k = key(x); if (!have.has(k)) { have.add(k); acc.txns.push(x); added++; } });
      acc.txns.sort((a, z) => (a.d < z.d ? -1 : a.d > z.d ? 1 : 0));
      acc.txns = acc.txns.slice(-20000).map((x) => { delete x.o; return x; });
      acc.updated = new Date().toISOString();
      acc.files = [{ name: String(b.file || ""), at: acc.updated, rows: rows.length, added, by: user }].concat(acc.files || []).slice(0, 50);
      await kvSet("tally_bank", bank);
      return OK({ ok: true, added, duplicates: rows.length - added, total: acc.txns.length, summary: bankSummary(bank) });
    }
    if (b.action === "ask") {
      const q = String(b.q || "").trim().slice(0, 1000); if (!q) return OK({ error: "empty question" });
      const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      await kvSet("tally_ask_" + id, { status: "pending", at: new Date().toISOString() });
      const base = process.env.URL || "https://rk-tracker-v2.netlify.app";
      await fetch(base + "/.netlify/functions/tally-ask-background", { method: "POST", headers: { "Content-Type": "application/json", "x-run-key": runKey() },
        body: JSON.stringify({ id, q, history: Array.isArray(b.history) ? b.history.slice(-6) : [] }) }).catch(() => {});
      return OK({ ok: true, id });
    }
    if (b.action === "askResult") {
      const r = await kvGet("tally_ask_" + String(b.id || "").replace(/[^a-z0-9]/gi, ""));
      return OK(Object.assign({ ok: true }, r || { status: "pending" }));
    }
    if (b.action === "askLog") return OK({ ok: true, log: ((await kvGet("tally_ask_log")) || []).slice(0, 20) });
    if (b.action === "remind") {
      const text = String(b.text || "").slice(0, 4000);
      if (!text) return OK({ error: "empty" });
      const r = await mail(s.accountantEmail, b.subject || "Pending in Tally — from Ravi", text + "\n\n— sent from RK Tracker");
      const log = (await kvGet("tally_reminders")) || [];
      log.unshift({ at: new Date().toISOString(), to: s.accountantEmail, subject: b.subject || "", text: text.slice(0, 500), ok: !!(r && r.ok) });
      await kvSet("tally_reminders", log.slice(0, 200));
      return OK({ ok: !!(r && r.ok), result: r });
    }
    if (b.action === "settingsSave") {
      const next = Object.assign({}, (await kvGet("tally_settings")) || {}, b.settings || {});
      await kvSet("tally_settings", next); return OK({ ok: true, settings: Object.assign({}, DEFAULTS, next) });
    }
    return OK({ error: "unknown action" });
  } catch (e) { return OK({ error: String(e.message || e) }); }
};
