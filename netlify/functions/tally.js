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
const DEFAULTS = { accountantEmail: "onammadhu@gmail.com", ownerEmail: "onamagarbathi@gmail.com", uploaders: ["main", "maadhu"], company: "" };
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
    if (b.action === "ingest") {
      const kind = b.kind, now = new Date().toISOString();
      const meta = (await kvGet("tally_meta")) || {};
      if (kind === "vouchers") {
        // merge by type+number+date; keep ~13 months
        const cur = (await kvGet("tally_vouchers")) || { list: [] };
        const map = new Map(cur.list.map(v => [v.t + "|" + v.n + "|" + v.d, v]));
        (b.data || []).forEach(v => { if (v && v.d) map.set(v.t + "|" + v.n + "|" + v.d, v); });
        const cutoff = new Date(Date.now() - 400 * 864e5).toISOString().slice(0, 10);
        const list = Array.from(map.values()).filter(v => v.d >= cutoff).sort((a, z) => a.d < z.d ? -1 : 1);
        await kvSet("tally_vouchers", { list });
        meta.vouchers = { at: now, by: user, count: list.length, upTo: list.length ? list[list.length - 1].d : null, file: b.file || "" };
      } else if (["tb", "recv", "pay", "stock"].includes(kind)) {
        await kvSet("tally_" + kind, { asof: b.asof || null, at: now, by: user, rows: b.data || [], file: b.file || "" });
        meta[kind] = { at: now, by: user, rows: (b.data || []).length, asof: b.asof || null, file: b.file || "" };
      } else return OK({ error: "unknown kind" });
      meta.lastUpload = now; meta.lastBy = user;
      await kvSet("tally_meta", meta);
      return OK({ ok: true, meta });
    }
    if (!owner) return OK({ error: "owner only" });
    if (b.action === "get") {
      const [meta, tb, recv, pay, stock, vch, lr] = await Promise.all(["tally_meta", "tally_tb", "tally_recv", "tally_pay", "tally_stock", "tally_vouchers", "logistics_v2"].map(kvGet));
      return OK({ ok: true, settings: s, meta: meta || {}, tb, recv, pay, stock, vouchers: (vch && vch.list) || [], dispatches: ((lr && lr.shipments) || []).filter(x => x.invoiceNo).map(x => ({ customer: x.customer, invoiceNo: x.invoiceNo, date: x.dispatchedOn || x.date, amount: x.invoiceAmount })) });
    }
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
