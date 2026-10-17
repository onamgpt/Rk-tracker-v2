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
    meta[kind] = { at: now, by, rows: (data || []).length, asof: asof || null, file: file || "" };
  } else return { error: "unknown kind" };
  meta.lastUpload = now; meta.lastBy = by;
  await kvSet("tally_meta", meta);
  return { ok: true, meta };
}
exports.ingest = ingest;

// ---- Audit: flag what an auditor would ask about, email new findings once ----
async function runAudit(prev, incoming, prevUpTo) {
  const A = require("./tally-audit.js");
  const st = (await kvGet("tally_audit")) || { open: [], reported: [] };
  const gone = new Set((st.open || []).filter((f) => /Deleted/.test(f.kind)).map((f) => (f.t || "") + "#" + (f.n || "")));
  const flags = A.check(prev || [], incoming || [], prevUpTo, gone);
  const known = new Set(st.reported || []);
  const fresh = flags.filter((f) => !known.has(f.key));
  if (!fresh.length) return null;
  const at = new Date().toISOString();
  fresh.forEach((f) => { f.found = at; f.status = "open"; known.add(f.key); });
  st.open = fresh.concat(st.open || []).slice(0, 2000);
  st.reported = Array.from(known).slice(-6000);
  st.at = at;
  await kvSet("tally_audit", st);
  const s = await settings();
  const upTo = incoming.length ? incoming.reduce((m, v) => (v.d > m ? v.d : m), incoming[0].d) : "";
  try {
    const m = require("./mail.js");
    await m.handler({ httpMethod: "POST", body: JSON.stringify({ to: s.ownerEmail, subject: "Tally audit check: " + fresh.length + " new item(s)" + (fresh.some((f) => f.sev === "high") ? " — includes important ones" : ""), html: A.emailBody(fresh.slice(), upTo) }) });
  } catch (e) {}
  const high = fresh.filter((f) => f.sev === "high").length;
  await tg("🧾 <b>Tally audit check</b> — " + fresh.length + " new item(s)" + (high ? ", " + high + " important" : "") + ":\n" +
    fresh.slice(0, 8).map((f) => "• " + f.kind + ": " + (f.t || "") + " " + (f.n || "") + " " + f.d).join("\n") + (fresh.length > 8 ? "\n…" : "") + "\nDetails emailed · https://rk-tracker-v2.netlify.app/tally/");
  return fresh.length;
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
    if (!owner) return OK({ error: "owner only" });
    if (b.action === "get") {
      const [meta, tb, recv, pay, stock, vch, lr] = await Promise.all(["tally_meta", "tally_tb", "tally_recv", "tally_pay", "tally_stock", "tally_vouchers", "logistics_v2"].map(kvGet));
      const gm = await kvGet("gmail_oauth"), mlog = (await kvGet("tally_mail_log")) || [], bankAll = await kvGet("tally_bank");
      return OK({ ok: true, bank: bankSummary(bankAll), gmail: gm && gm.refresh ? { email: gm.email || "", at: gm.at } : null, mailLog: mlog.slice(0, 10), settings: s, meta: meta || {}, tb, recv, pay, stock, vouchers: (vch && vch.list) || [], dispatches: ((lr && lr.shipments) || []).filter(x => x.invoiceNo).map(x => ({ customer: x.customer, invoiceNo: x.invoiceNo, date: x.dispatchedOn || x.date, amount: x.invoiceAmount })) });
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
