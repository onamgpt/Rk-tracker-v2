// Automatic inward: supplier bills become "expected deliveries" with labels printed in advance.
// Sources: (1) vendor bill PDFs by email (known vendors, onamagarbathi+inward@gmail.com, or any invoice-like PDF
// billed to Onam), (2) bill / e-way bill photos posted in the Telegram Purchase group, (3) purchase orders.
// Security only sticks the labels and scans each package on arrival. Never writes to Tally.
const crypto = require("crypto");
const https = require("https");
const L = require("./purchase-lib.js");
const DAY = () => L.todayIST();
const num = (x) => { const n = parseFloat(String(x == null ? "" : x).replace(/,/g, "")); return isFinite(n) ? n : 0; };
const clip = (s, n) => String(s == null ? "" : s).trim().slice(0, n || 120);
const OWN = ["onamagarbathi@gmail.com", "onammadhu@gmail.com", "mgrgp2@gmail.com", "pafa@csdindia.gov.in", "prakashonam@gmail.com", "onamviru@gmail.com"];

async function claudeDocs(docs, prompt) {
  const key = process.env.ANTHROPIC_API_KEY; if (!key) throw new Error("ANTHROPIC_API_KEY not set");
  const content = docs.map((d) => d.media === "application/pdf"
    ? { type: "document", source: { type: "base64", media_type: "application/pdf", data: d.data.toString("base64") } }
    : { type: "image", source: { type: "base64", media_type: d.media, data: d.data.toString("base64") } });
  content.push({ type: "text", text: prompt });
  const r = await fetch("https://api.anthropic.com/v1/messages", { method: "POST", headers: { "Content-Type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: 6000, system: "Return ONLY valid JSON.", messages: [{ role: "user", content }] }) });
  const d = await r.json(); if (d.error) throw new Error(d.error.message || "model error");
  const t = (d.content || []).map((c) => c.text || "").join("").replace(/```json|```/g, "").trim();
  return JSON.parse(t.slice(t.indexOf("{"), t.lastIndexOf("}") + 1));
}
async function readBill(docs) {
  const shape = '{"kind":"bill","buyerIsOnam":true,"supplier":"","supplierGstin":"","billNo":"","billDate":"YYYY-MM-DD","ewayBill":"","lines":[{"item":"","qty":0,"unit":"kg","packages":0,"packType":"drum|bag|box|carton|bundle","batch":"","expiry":"YYYY-MM-DD"}]}';
  return claudeDocs(docs, "Is this a supplier's tax invoice, bill, delivery challan or e-way bill for goods sold TO Onam Agarbathi (the buyer / consignee)? " +
    "If it is NOT such a document (for example a photo of a lorry or goods, or a bill where Onam is the seller), return {\"kind\":\"photo\"}. Otherwise return ONLY JSON in this shape: " + shape +
    ". packages = number of drums, bags, boxes or cartons for that line if stated (0 if not stated). Include batch and expiry where printed. Dates YYYY-MM-DD.");
}

// ---------- expected deliveries ----------
function packSizeFor(item, cat, unit, items) {
  const c = items[item] || {}; if (+c.packSize > 0) return +c.packSize;
  if (cat === "raw" && /kg/i.test(unit || "")) return 25;      // raw incense material comes in 25 kg bags
  return 0;
}
function matchItem(name, known) {
  const n = L.norm(name); if (!n) return name;
  return known.find((k) => L.norm(k) === n) || known.find((k) => L.norm(k).indexOf(n) >= 0 || n.indexOf(L.norm(k)) >= 0) || name;
}
async function createExpected(bill, source, extra) {
  const exps = (await L.kvGet("inv_expected")) || [];
  const sup = clip(bill.supplier), billNo = clip(bill.billNo, 40);
  if (billNo && exps.some((e) => L.norm(e.supplier) === L.norm(sup) && e.billNo === billNo)) return { dup: true };
  const items = (await L.kvGet("purchase_items")) || {}, tst = ((await L.kvGet("tally_stock")) || {}).rows || [];
  const known = Array.from(new Set(Object.keys(items).concat(tst.map((r) => r.item))));
  const lots = (await L.kvGet("inv_lots")) || [], today = DAY(), ts = Date.now();
  const exp = { id: "ex_" + crypto.randomBytes(5).toString("hex"), supplier: sup, gstin: clip(bill.supplierGstin, 20), billNo, billDate: bill.billDate || today, eway: clip(bill.ewayBill, 20),
    source, created: today, printed: false, lines: [], photos: [], note: (extra && extra.note) || "" };
  (bill.lines || []).forEach((ln) => {
    const qty = num(ln.qty); if (!(qty > 0) || !ln.item) return;
    const item = matchItem(clip(ln.item), known), cat = (items[item] && items[item].cat) || L.classify(item), unit = clip(ln.unit, 12) || "kg";
    let n = Math.floor(num(ln.packages)), check = false;
    if (!(n >= 1)) { const ps = packSizeFor(item, cat, unit, items); n = ps ? Math.max(1, Math.ceil(qty / ps)) : 1; check = !ps; }
    n = Math.min(n, 300);
    const per = Math.round(qty / n * 1000) / 1000;
    for (let i = 0; i < n; i++) lots.push({ id: "lt_" + crypto.randomBytes(5).toString("hex"), token: crypto.randomBytes(9).toString("base64url"), item, cat, unit, qty: per, orig: per,
      supplier: sup, bill: billNo, recvd: "", no: i + 1, of: n, status: "expected", expId: exp.id, batch: clip(ln.batch, 30), expiry: ln.expiry || "", ev: [{ t: "billed", d: today, ts, by: source, q: per }] });
    exp.lines.push({ item, cat, qty, unit, packages: n, per, packType: ln.packType || "", batch: clip(ln.batch, 30), expiry: ln.expiry || "", checkPackages: check });
  });
  if (!exp.lines.length) return { empty: true };
  exps.unshift(exp);
  await L.kvSet("inv_expected", exps.slice(0, 400)); await L.kvSet("inv_lots", lots);
  await learnSupplier(sup, extra && extra.email, null);
  return { exp };
}
async function learnSupplier(name, email, transitDays) {
  if (!name) return; const S = (await L.kvGet("inv_suppliers")) || {}; const k = L.norm(name);
  const s = S[k] = S[k] || { name, emails: [], transits: [], transitSet: 0 };
  if (email && s.emails.indexOf(email) < 0) s.emails.push(email);
  if (transitDays != null && transitDays >= 0) s.transits = (s.transits || []).concat(transitDays).slice(-12);
  await L.kvSet("inv_suppliers", S);
}
function transitFor(S, name) {
  const s = S[L.norm(name)] || {}; if (+s.transitSet > 0) return +s.transitSet;
  const t = (s.transits || []).slice().sort((a, b) => a - b); return t.length ? t[Math.floor(t.length / 2)] : 7;
}
// Purchase order → expected delivery (only when the pack size is known)
async function fromPO(p) {
  const items = (await L.kvGet("purchase_items")) || {}; const cat = (items[p.item] && items[p.item].cat) || L.classify(p.item);
  if (!packSizeFor(p.item, cat, p.unit || "kg", items)) return null;
  return createExpected({ supplier: p.supplier || "", billNo: p.poNo || "", billDate: p.orderedOn, lines: [{ item: p.item, qty: p.orderedQty || p.qty, unit: p.unit || "kg", packages: 0 }] }, "purchase order", { note: "From " + (p.poNo || "purchase order") });
}

// ---------- Telegram Purchase group ----------
function tgApi(method, payload) {
  const BOT = process.env.TELEGRAM_BOT_TOKEN || ""; if (!BOT) return Promise.resolve({ ok: false });
  return new Promise((res) => { const body = JSON.stringify(payload || {});
    const req = https.request({ hostname: "api.telegram.org", path: "/bot" + BOT + "/" + method, method: "POST", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) } },
      (r) => { let d = ""; r.on("data", (c) => (d += c)); r.on("end", () => { try { res(JSON.parse(d)); } catch (e) { res({ ok: false }); } }); });
    req.on("error", () => res({ ok: false })); req.write(body); req.end(); });
}
function tgFile(path) {
  const BOT = process.env.TELEGRAM_BOT_TOKEN || "";
  return new Promise((res) => { https.get("https://api.telegram.org/file/bot" + BOT + "/" + path, (r) => { const ch = []; r.on("data", (c) => ch.push(c)); r.on("end", () => res(Buffer.concat(ch))); }).on("error", () => res(null)); });
}
async function pollTelegram(log) {
  const st = (await L.kvGet("inv_tg_state")) || { offset: 0, groups: {} };
  const r = await tgApi("getUpdates", { offset: st.offset || 0, limit: 50, timeout: 0 });
  if (!r.ok) { log.push("telegram: not reachable"); return; }
  const T = require("./tally.js"); const contacts = (await L.kvGet("tg_contacts")) || [];
  for (const u of r.result || []) {
    st.offset = u.update_id + 1;
    const m = u.message || u.channel_post; if (!m || !m.chat) continue;
    const c = m.chat, id = String(c.id);
    if (c.type !== "private") {
      const role = /purchase|inward/i.test(c.title || "") ? "inwards" : /sale|dispatch|invoice/i.test(c.title || "") ? "sales" : "other";
      st.groups[id] = { title: c.title || "", role };
      if (!contacts.some((x) => x.chatId === id)) contacts.push({ name: c.title || id, label: c.title || id, chatId: id });
      if (role !== "inwards") continue;
      let fileId = null, media = "image/jpeg";
      if (m.photo && m.photo.length) fileId = m.photo[m.photo.length - 1].file_id;
      else if (m.document && /pdf|image/i.test(m.document.mime_type || "")) { fileId = m.document.file_id; media = m.document.mime_type; }
      if (!fileId) continue;
      const f = await tgApi("getFile", { file_id: fileId }); if (!f.ok) continue;
      const buf = await tgFile(f.result.file_path); if (!buf) continue;
      let url = ""; try { url = await T.vaultSaveFile("Inward " + DAY() + " - " + (m.from && m.from.first_name || "group") + (media === "application/pdf" ? ".pdf" : ".jpg"), media, buf, { kind: "inward_photo", data: [], by: "telegram", source: "telegram" }); } catch (e) {}
      let bill = null; try { bill = await readBill([{ media, data: buf }]); } catch (e) { log.push("telegram read: " + e.message); }
      if (bill && bill.kind === "bill" && bill.buyerIsOnam !== false) {
        const x = await createExpected(bill, "telegram", { note: "Bill photo in Telegram" });
        if (x.exp) { x.exp.photos.push(url); const exps = await L.kvGet("inv_expected"); exps[0] = x.exp; await L.kvSet("inv_expected", exps);
          log.push("telegram bill: " + x.exp.supplier + " " + x.exp.billNo);
          await tgApi("sendMessage", { chat_id: id, text: "✅ Bill read: " + x.exp.supplier + " · " + x.exp.lines.map((l) => l.item + " ×" + l.packages).join(", ") + ". Labels are ready to print in the office." }); }
        else if (x.dup) await tgApi("sendMessage", { chat_id: id, text: "ℹ️ This bill is already in the system." });
      } else {
        // a lorry / delivery-proof photo: attach to today's deliveries being received, else keep for the day
        const exps = (await L.kvGet("inv_expected")) || [], lots = (await L.kvGet("inv_lots")) || [];
        const today = DAY(), hit = exps.find((e) => lots.some((l) => l.expId === e.id && l.recvd === today)) || exps.find((e) => !e.done);
        if (hit) { hit.photos = (hit.photos || []).concat(url).slice(-10); await L.kvSet("inv_expected", exps); }
        const P = (await L.kvGet("inv_photos")) || []; P.unshift({ d: today, url, exp: hit ? hit.id : null, from: (m.from && m.from.first_name) || "" }); await L.kvSet("inv_photos", P.slice(0, 300));
      }
    }
  }
  await L.kvSet("tg_contacts", contacts); await L.kvSet("inv_tg_state", st);
}

// ---------- email ----------
async function pollMail(log, first) {
  const G = require("./gmail.js"); const S = (await L.kvGet("inv_suppliers")) || {};
  const st = (await L.kvGet("inv_mail_state")) || { seen: [] };
  const days = first ? 7 : 4, emails = Array.from(new Set([].concat.apply([], Object.values(S).map((s) => s.emails || [])))).slice(0, 40);
  const qs = ["to:onamagarbathi+inward@gmail.com newer_than:" + days + "d",
    'has:attachment filename:pdf subject:(invoice OR bill OR "tax invoice" OR "e-way" OR challan) newer_than:' + days + "d " + OWN.map((e) => "-from:" + e).join(" ")];
  if (emails.length) qs.push("has:attachment from:(" + emails.join(" OR ") + ") newer_than:" + days + "d");
  let n = 0;
  for (const q of qs) {
    const { tok, messages } = await G.search(q, 15);
    for (const m of messages) {
      if (st.seen.indexOf(m.id) >= 0 || n >= 15) continue;
      const pdfs = (m.attachments || []).filter((a) => /\.pdf$/i.test(a.name)).slice(0, 3);
      st.seen.push(m.id); if (!pdfs.length) continue; n++;
      try {
        const docs = []; for (const a of pdfs) docs.push({ media: "application/pdf", data: await G.attachment(tok, m.id, a.id) });
        const bill = await readBill(docs);
        if (!bill || bill.kind !== "bill" || bill.buyerIsOnam === false) continue;
        const email = (String(m.from || "").match(/[\w.+-]+@[\w.-]+/) || [""])[0].toLowerCase();
        const x = await createExpected(bill, "email", { email, note: m.subject || "" });
        if (x.exp) log.push("email bill: " + x.exp.supplier + " " + x.exp.billNo + " (" + x.exp.lines.length + " lines)");
      } catch (e) { log.push("mail " + m.id + ": " + e.message); }
    }
  }
  st.seen = st.seen.slice(-800); await L.kvSet("inv_mail_state", st);
}

async function run(opt) {
  opt = opt || {}; const log = [];
  const st = (await L.kvGet("inv_mail_state")) || null;
  try { await pollMail(log, !st); } catch (e) { log.push("mail: " + e.message); }
  try { await pollTelegram(log); } catch (e) { log.push("telegram: " + e.message); }
  const R = (await L.kvGet("inv_inward_log")) || []; R.unshift({ at: new Date().toISOString(), log }); await L.kvSet("inv_inward_log", R.slice(0, 40));
  return log;
}
module.exports = { run, readBill, createExpected, fromPO, learnSupplier, transitFor, packSizeFor, matchItem };
