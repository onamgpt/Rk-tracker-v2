// Sales reps on the office WhatsApp number.
//   order   → straight into the Dispatch Register (logistics_v2) under the rep's name; Prakash told; rep gets the order no.
//   status  → the rep's own orders only: stage, invoice, dispatch/LR, delivered, invoice / paid / balance
//   payment → recorded on the rep's order as "reported by rep – to verify"; Prakash + Maadhu told
//   auto    → rep gets a WhatsApp when their order is Ready, Invoiced, Dispatched or Delivered (from label-cron)
// Reps never see stock, prices, other reps' orders, accounts or anything else.
// Ravi manages reps on WhatsApp: "add rep Sooraj 9876543210", "remove rep Sooraj", "reps".
const crypto = require("crypto");
const W = require("./wa-lib.js");

const digits = (s) => { let d = String(s || "").replace(/\D/g, "").replace(/^0+/, ""); if (d.length === 10) d = "91" + d; return d; };
const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
const inr = (n) => "₹" + Math.round(Number(n) || 0).toLocaleString("en-IN");
const paid = (x) => (x.payments || []).reduce((a, p) => a + (Number(p.amount) || 0), 0);
const fmtD = (d) => (d ? new Date(d + "T00:00:00Z").toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" }) : "");

async function reps() { return (await W.kvGet("wa_sales_reps")) || []; }
async function repByPhone(num) {
  const d = digits(num); if (!d) return null;
  return (await reps()).find((r) => r.active !== false && digits(r.phone) === d) || null;
}

async function ownerCmd(text) {
  const t = String(text || "").trim();
  let m = t.match(/^add\s+(?:sales\s+)?rep\s+(.+?)\s+(\+?[\d][\d\s-]{8,})$/i);
  if (m) {
    const list = await reps(), ph = digits(m[2]);
    if (ph.length < 12) return "That number doesn't look right. Example: *add rep Sooraj 9876543210*";
    const ex = list.find((r) => digits(r.phone) === ph);
    if (ex) { ex.name = m[1].trim(); ex.active = true; } else list.push({ name: m[1].trim(), phone: ph, active: true, added: W.istDate() });
    await W.kvSet("wa_sales_reps", list);
    await W.send(ph, "👋 Hello " + m[1].trim() + ", this is the *Onam Agarbathi office* number.\nSend your *orders* here (customer, place, items) and ask *status of <customer>* or *my orders* anytime. Payments: *payment ₹amount from <customer>, UTR …*");
    return "✅ Sales rep added: " + m[1].trim() + " (+" + ph + "). A welcome message was sent to them.";
  }
  m = t.match(/^remove\s+(?:sales\s+)?rep\s+(.+)$/i);
  if (m) {
    const list = await reps(), r = list.find((x) => norm(x.name) === norm(m[1]) || digits(x.phone) === digits(m[1]));
    if (!r) return "No rep called " + m[1] + ". Send *reps* to see the list.";
    r.active = false; await W.kvSet("wa_sales_reps", list); return "Removed " + r.name + " – that number gets no replies now.";
  }
  if (/^(reps|sales reps|list reps)\??$/i.test(t)) {
    const list = (await reps()).filter((r) => r.active !== false);
    return list.length ? "*Sales reps on WhatsApp*\n" + list.map((r) => "• " + r.name + " +" + r.phone).join("\n") : "No sales reps yet. Add one: *add rep Sooraj 9876543210*";
  }
  return null;
}

function stage(x) {
  if (x.deliveredOn) return { k: "delivered", t: "✅ Delivered " + fmtD(x.deliveredOn) };
  if (x.dispatchedOn) return { k: "dispatched", t: "🚚 Dispatched " + fmtD(x.dispatchedOn) + (x.transporter ? " by " + x.transporter : "") + (x.lrNo ? " · LR " + x.lrNo : "") };
  if (String(x.invoiceNo || "").trim()) return { k: "invoiced", t: "🧾 Invoiced (" + x.invoiceNo + ") – packing for dispatch" };
  if (/ready/i.test(x.production || "")) return { k: "ready", t: "📦 Ready – invoice next" };
  if (/production/i.test(x.production || "")) return { k: "production", t: "🏭 In production" };
  return { k: "new", t: "📝 Order received – production not started" };
}
function card(x, money) {
  const st = stage(x), inv = Number(x.invoiceAmount) || 0, pd = paid(x);
  return "*" + (x.customer || "").trim() + "*" + (x.destination ? ", " + x.destination.trim() : "") + " · Order " + (x.orderNo || "-") + (x.orderDate ? " (" + fmtD(x.orderDate) + ")" : "") +
    "\n" + st.t + (money && inv ? "\nInvoice " + inr(inv) + " · Paid " + inr(pd) + " · *Balance " + inr(Math.max(0, inv - pd)) + "*" : "");
}
async function shipments() { return ((await W.kvGet("logistics_v2")) || {}).shipments || []; }
const isMine = (x, rep) => digits(x.repPhone) === digits(rep.phone);

// save one shipment the same way the Dispatch Register does (arrays merged by id, nothing lost)
const ARR = ["files", "payments", "log", "reminders", "materials"];
async function saveShipment(inc) {
  const data = (await W.kvGet("logistics_v2")) || { shipments: [] }, list = data.shipments || [];
  const i = list.findIndex((x) => x.id === inc.id), old = i >= 0 ? list[i] : null;
  let out = inc;
  if (old) { out = Object.assign({}, old, inc); ARR.forEach((k) => { const m = new Map(); (old[k] || []).forEach((x) => x && x.id && m.set(x.id, x)); (inc[k] || []).forEach((x) => x && x.id && m.set(x.id, x)); out[k] = Array.from(m.values()); }); }
  if (i >= 0) list[i] = out; else list.unshift(out);
  await W.kvSet("logistics_v2", { shipments: list, updated: new Date().toISOString() });
  return out;
}
const uid = (p) => p + Date.now().toString(36) + crypto.randomBytes(3).toString("hex");

async function handleRep(row, rep, reply, media, mediaPath) {
  const text = String(row.body || "").trim();
  const mineAll = (await shipments()).filter((x) => isMine(x, rep));
  const content = [];
  if (media) content.push(media.type === "application/pdf" ? { type: "document", source: { type: "base64", media_type: "application/pdf", data: media.b64 } } : { type: "image", source: { type: "base64", media_type: media.type, data: media.b64 } });
  content.push({ type: "text", text: "Rep's customers so far: " + [...new Set(mineAll.map((x) => (x.customer || "").trim()))].join(", ") + "\n\nMessage from sales rep " + rep.name + ":\n" + (text || "(see attachment)") });
  let d = {};
  try {
    d = W.parseJSON(await W.claude(content, "You read WhatsApp messages from Onam Agarbathi's sales reps. Reply with JSON only: " +
      '{"intent":"order|status|payment|other","customer":"","destination":"","items":"","cartons":"","note":"","amount":0,"utr":"","mode":""}. ' +
      "order = a new order to supply (items/quantities for a customer; copy the items exactly as written, one line per product). status = asking where an order is, what's pending, balance or payment due (customer may be blank = all their orders). " +
      "payment = telling us a customer paid (amount, UTR/cheque/cash). other = anything else. For a photo of an order slip, read it.", 900));
  } catch (e) { await reply("Sorry, I couldn't read that. Please send again: customer name, place, and items."); return "rep parse failed"; }

  const pick = (list) => { if (!d.customer) return list; const n = norm(d.customer); return list.filter((x) => norm(x.customer).includes(n) || n.includes(norm(x.customer))); };

  if (d.intent === "order" && (d.items || media)) {
    const all = await shipments();
    const next = Math.max(0, ...all.map((x) => parseInt(x.orderNo, 10)).filter((n) => n > 0 && n < 100000)) + 1;
    const today = W.istDate(), now = new Date().toISOString();
    const s = { id: "s" + Date.now().toString(36) + crypto.randomBytes(3).toString("hex"), orderNo: String(next), date: today, orderDate: today,
      customer: (d.customer || "").trim() || "(customer?)", destination: (d.destination || "").trim(), items: (d.items || "(see photo)").trim(), qty: String(d.cartons || "").trim(),
      notes: [(d.note || "").trim(), "Order from " + rep.name + " on WhatsApp"].filter(Boolean).join(" · "), production: "Not started", rep: rep.name, repPhone: digits(rep.phone),
      files: mediaPath ? [{ id: uid("f"), name: "WhatsApp order photo", path: mediaPath, at: now }] : [], payments: [], reminders: [], materials: [],
      log: [{ id: uid("l"), at: now, by: "whatsapp", text: "Order received on WhatsApp from " + rep.name }], createdAt: now, createdBy: "whatsapp:" + rep.name, updatedAt: now, updatedBy: "whatsapp" };
    await saveShipment(s);
    await W.send(["prakash", "ravi"], "🧾 *New order on WhatsApp* from " + rep.name + "\n*" + s.customer + "*" + (s.destination ? ", " + s.destination : "") + " · Order " + s.orderNo + "\n" + s.items.slice(0, 600) +
      "\nIt's in the Dispatch Register – check the items and plan production.", { kind: "order" });
    await reply("✅ *Order " + s.orderNo + " received* – " + s.customer + (s.destination ? ", " + s.destination : "") + "\n" + s.items.slice(0, 500) +
      "\nPrakash has it. Ask *status of " + s.customer.split(/\s+/)[0] + "* anytime – you'll also get a message when it's invoiced and dispatched." +
      (s.customer === "(customer?)" ? "\n⚠️ Customer name missing – please send it." : ""));
    return "rep order " + s.orderNo;
  }
  if (d.intent === "payment" && Number(d.amount) > 0) {
    const cands = pick(mineAll).filter((x) => Number(x.invoiceAmount) > paid(x)).sort((a, b) => String(b.dispatchedOn || b.date).localeCompare(String(a.dispatchedOn || a.date)));
    if (!cands.length) { await reply("I couldn't find an unpaid invoice for " + (d.customer || "that customer") + " among your orders. Send: *payment ₹amount from <customer>, UTR …*"); return "rep payment unmatched"; }
    const x = cands[0], now = new Date().toISOString();
    const up = await saveShipment({ id: x.id, payments: [{ id: uid("p"), date: W.istDate(), amount: Number(d.amount), mode: d.mode || "", note: "Reported by " + rep.name + " on WhatsApp – to verify" + (d.utr ? " · UTR " + d.utr : "") }],
      log: [{ id: uid("l"), at: now, by: "whatsapp", text: "Payment " + inr(d.amount) + " reported by " + rep.name + (d.utr ? " (UTR " + d.utr + ")" : "") }] });
    await W.send(["prakash", "maadhu", "ravi"], "💰 *Payment reported* by " + rep.name + ": " + inr(d.amount) + " from *" + x.customer + "*" + (d.utr ? " · UTR " + d.utr : "") + (d.mode ? " · " + d.mode : "") +
      "\nInvoice " + (x.invoiceNo || "-") + " · please verify in the bank and Tally.", { kind: "payment" });
    await reply("✅ Noted " + inr(d.amount) + " from " + x.customer + " (invoice " + (x.invoiceNo || "-") + "). Office will verify.\nBalance now " + inr(Math.max(0, (Number(up.invoiceAmount) || 0) - paid(up))) + ".");
    return "rep payment";
  }
  if (d.intent === "status" || d.intent === "payment") {
    let list = pick(mineAll);
    if (!d.customer) list = list.filter((x) => !x.deliveredOn || Number(x.invoiceAmount) > paid(x));
    list = list.sort((a, b) => String(b.orderDate || b.date || "").localeCompare(String(a.orderDate || a.date || ""))).slice(0, 8);
    if (!list.length) { await reply(d.customer ? "No order for " + d.customer + " under your name. Check the spelling, or send the order." : "You have no open orders right now."); return "rep status none"; }
    const due = list.reduce((a, x) => a + Math.max(0, (Number(x.invoiceAmount) || 0) - paid(x)), 0);
    await reply(list.map((x) => card(x, true)).join("\n\n") + (due ? "\n\n*Total balance due: " + inr(due) + "*" : ""));
    return "rep status " + list.length;
  }
  await reply("Hi " + rep.name + " 👋 On this number you can:\n• send an *order* (customer, place, items)\n• ask *status of <customer>* or *my orders*\n• report *payment ₹amount from <customer>, UTR …*");
  return "rep help";
}

// called every minute from label-cron: tell the rep when their order moves on
async function notifyChanges(state) {
  const seen = state.repStage = state.repStage || {};
  const list = (await shipments()).filter((x) => x.repPhone);
  for (const x of list) {
    const st = stage(x).k;
    if (seen[x.id] === undefined) { seen[x.id] = st; continue; }
    if (seen[x.id] === st) continue;
    seen[x.id] = st;
    if (["ready", "invoiced", "dispatched", "delivered"].includes(st)) await W.send(x.repPhone, "🔔 Order update\n" + card(x, st === "invoiced" || st === "dispatched"), { kind: "order" });
  }
}

module.exports = { repByPhone, reps, ownerCmd, handleRep, notifyChanges, stage, card };
