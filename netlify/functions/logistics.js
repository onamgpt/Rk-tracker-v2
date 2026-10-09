// Dispatch Register (lorry / LR tracker) — Prakash enters, Ravi sees.
// One record per shipment, PIN-checked on every call, merged field-by-field
// so phone and desktop can be used at the same time without losing photos.
const crypto = require("crypto");
const db = require("./db.js");
const H = { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json", "Access-Control-Allow-Headers": "Content-Type" };
const OK = (o) => ({ statusCode: 200, headers: H, body: JSON.stringify(o) });
const call = async (b) => JSON.parse((await db.handler({ httpMethod: "POST", body: JSON.stringify(b) })).body || "{}");
const kvGet = async (k) => { const r = await call({ action: "getPortfolio", user: "main", key: k }); return r && r.data != null ? r.data : null; };
const kvSet = (k, d) => call({ action: "savePortfolio", user: "main", key: k, data: d });
const hash = (p) => crypto.createHash("sha256").update("rkpin:" + p).digest("hex");
const OWNER_CHAT = "8632288596";
const KEY = "logistics_v2";

const DEFAULTS = { users: ["main", "prakash"], deliveryDays: 7, paymentDays: 30, docDays: 1, extra1: "Vehicle number", extra2: "Driver phone",
  prakashChat: "", groupChat: "", dispatchToGroup: false, digestToGroup: true, digestToOwner: true,
  prakashEmail: "", emailToPrakash: true, telegramToPrakash: true };

async function settings() {
  const s = Object.assign({}, DEFAULTS, (await kvGet("logistics_settings")) || {});
  // Find Prakash and the team group in the bot's contact list if not set by hand.
  if (!s.prakashChat || !s.groupChat) {
    const contacts = (await kvGet("tg_contacts")) || [];
    if (!s.prakashChat) { const p = contacts.find(c => /prakash/i.test((c.label || "") + " " + (c.name || ""))); if (p) s.prakashChat = String(p.chatId); }
    if (!s.groupChat) { const g = contacts.filter(c => String(c.chatId).indexOf("-") === 0); const pick = g.find(c => /sales|order|onam|team|staff|despatch|dispatch|logist|office/i.test((c.label || "") + " " + (c.name || ""))) || (g.length === 1 ? g[0] : null); if (pick) s.groupChat = String(pick.chatId); }
  }
  return s;
}
exports.settings = settings;

async function who(user, pin, s) {
  user = String(user || "").toLowerCase();
  if (!(s.users || []).includes(user) || !pin) return null;
  const pins = (await kvGet("user_pins")) || {};
  return pins[user] && pins[user] === hash(String(pin)) ? user : null;
}

async function tgSend(chatIds, text) {
  chatIds = (chatIds || []).filter(Boolean); if (!chatIds.length) return;
  const base = process.env.URL || "https://rk-tracker-v2.netlify.app";
  try { await fetch(base + "/.netlify/functions/telegram", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "send", chatIds, message: text }) }); } catch (e) {}
}
exports.tgSend = tgSend;
const esc = (s) => String(s == null ? "" : s).replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
exports.esc = esc;
const inr = (n) => "₹" + Math.round(Number(n) || 0).toLocaleString("en-IN");
exports.inr = inr;

// arrays merged by id: incoming wins for the same id, nothing silently lost
const ARR = ["files", "payments", "log", "reminders", "materials"];
function merge(old, inc) {
  if (!old) return inc;
  const out = Object.assign({}, old, inc);
  ARR.forEach(k => {
    const m = new Map(); (old[k] || []).forEach(x => x && x.id && m.set(x.id, x)); (inc[k] || []).forEach(x => x && x.id && m.set(x.id, x));
    const del = new Set(inc["_del_" + k] || []);
    out[k] = Array.from(m.values()).filter(x => !del.has(x.id));
    delete out["_del_" + k];
  });
  return out;
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers: H, body: "" };
  let b = {}; try { b = JSON.parse(event.body || "{}"); } catch (e) { return OK({ error: "bad request" }); }
  const s = await settings();
  const me = await who(b.user, b.pin, s);
  if (!me) return OK({ error: "pin" });
  const owner = me === "main";
  try {
    if (b.action === "get") {
      const data = (await kvGet(KEY)) || { shipments: [] };
      const pub = Object.assign({}, s); if (!owner) { delete pub.users; }
      return OK({ ok: true, me, owner, shipments: data.shipments || [], settings: pub });
    }
    if (b.action === "save" && b.shipment && b.shipment.id) {
      const data = (await kvGet(KEY)) || { shipments: [] };
      const list = data.shipments || [];
      const i = list.findIndex(x => x.id === b.shipment.id);
      const isNew = i < 0;
      const inc = Object.assign({}, b.shipment, { updatedAt: new Date().toISOString(), updatedBy: me });
      if (isNew) { inc.createdAt = inc.createdAt || inc.updatedAt; inc.createdBy = me; }
      const prev = isNew ? null : list[i];
      const merged = merge(prev, inc);
      const dispOf = (x) => x ? (x.dispatchedOn || (x.orderDate === undefined ? x.date : "")) : "";
      if (isNew) list.unshift(merged); else list[i] = merged;
      await kvSet(KEY, { shipments: list, updated: inc.updatedAt });
      if (isNew && !dispOf(merged)) {
        const t = "🧾 <b>New order</b> · " + esc(merged.customer || "—") + (merged.orderNo ? " · PO " + esc(merged.orderNo) : "") +
          (merged.items ? "\n" + esc(String(merged.items).slice(0, 200)) : "") + (merged.expectedDispatch ? "\n📅 dispatch by " + esc(merged.expectedDispatch) : "") +
          ((merged.materials || []).length ? "\n🧪 materials pending: " + esc(merged.materials.filter(m => !m.received).map(m => m.name).join(", ")) : "") + "\n— entered by " + esc(me);
        await tgSend([OWNER_CHAT].concat(s.dispatchToGroup ? [s.groupChat] : []), t);
      }
      if (dispOf(merged) && !dispOf(prev)) {
        const t = "🚚 <b>Dispatched</b> · " + esc(merged.customer || "—") + (merged.invoiceNo ? " · Inv " + esc(merged.invoiceNo) : "") +
          (merged.invoiceAmount ? " · " + inr(merged.invoiceAmount) : "") + (merged.transporter ? "\n" + esc(merged.transporter) : "") + (merged.lrNo ? " · LR " + esc(merged.lrNo) : "") +
          (merged.freight ? " · freight " + inr(merged.freight) : "") + (merged.destination ? "\n📍 " + esc(merged.destination) : "") + "\n— entered by " + esc(me);
        await tgSend([OWNER_CHAT].concat(s.dispatchToGroup ? [s.groupChat] : []), t);
      }
      return OK({ ok: true, shipment: merged });
    }
    if (b.action === "delete" && b.id) {
      if (!owner) return OK({ error: "Only Ravi can delete" });
      const data = (await kvGet(KEY)) || { shipments: [] };
      await kvSet(KEY, { shipments: (data.shipments || []).filter(x => x.id !== b.id), updated: new Date().toISOString() });
      return OK({ ok: true });
    }
    if (b.action === "remind" && b.when && b.text) {
      // manual reminder → the same Telegram scheduler the tracker uses
      const cur = await kvGet("tg_scheduled"); const list = (cur && Array.isArray(cur.scheduled)) ? cur.scheduled : [];
      const to = [s.prakashChat || OWNER_CHAT].concat(b.toGroup && s.groupChat ? [s.groupChat] : []).concat(b.toOwner ? [OWNER_CHAT] : []);
      const id = "lr_rem_" + Date.now().toString(36);
      list.push({ id, text: "⏰ " + esc(b.text), chatIds: Array.from(new Set(to.filter(Boolean))), when: new Date(b.when).toISOString(), repeat: "once", owner: me, created: new Date().toISOString(),
        emails: s.prakashEmail ? [s.prakashEmail] : [], subject: "Reminder: " + String(b.text).slice(0, 80), body: String(b.text) });
      await kvSet("tg_scheduled", { scheduled: list });
      return OK({ ok: true, id, to: [s.prakashChat ? "Prakash on Telegram" : "", s.prakashEmail ? "Prakash by email" : "", !s.prakashChat && !s.prakashEmail ? "Ravi (no Telegram/email for Prakash yet)" : ""].filter(Boolean).join(" + ") });
    }
    if (b.action === "share" && b.text) { await tgSend(b.toGroup ? [s.groupChat] : [s.prakashChat || OWNER_CHAT], b.text); return OK({ ok: true }); }
    if (b.action === "contacts") { if (!owner) return OK({ error: "owner only" }); return OK({ ok: true, contacts: (await kvGet("tg_contacts")) || [] }); }
    if (b.action === "settingsSave") {
      if (!owner) return OK({ error: "owner only" });
      const cur = (await kvGet("logistics_settings")) || {};
      const next = Object.assign({}, cur, b.settings || {}); if (!next.users || !next.users.includes("main")) next.users = DEFAULTS.users;
      await kvSet("logistics_settings", next);
      return OK({ ok: true, settings: Object.assign({}, DEFAULTS, next) });
    }
    if (b.action === "testAlert") {
      let mail = null;
      if (s.prakashEmail) { try { const m = require("./mail.js"); const r = await m.handler({ httpMethod: "POST", body: JSON.stringify({ to: s.prakashEmail, subject: "Orders & Dispatch — test email", text: "This is a test. Your morning summary will arrive here every day at 9:30." }) }); mail = JSON.parse(r.body); } catch (e) { mail = { ok: false, error: String(e) }; } }
      await tgSend([s.prakashChat, owner ? OWNER_CHAT : null].concat(b.toGroup ? [s.groupChat] : []), "✅ Dispatch Register test alert — Telegram is working.");
      return OK({ ok: true, prakash: !!s.prakashChat, group: !!s.groupChat, email: mail ? (mail.ok ? "sent" : (mail.reason || mail.error || "failed")) : "no email set" });
    }
    return OK({ error: "unknown action" });
  } catch (e) { return OK({ error: String(e.message || e) }); }
};
