// Every morning 9:30 IST: chase pending deliveries, unpaid bills, missing
// documents and today's follow-ups — Telegram to Prakash, digest to Ravi/group.
const db = require("./db.js");
const L = require("./logistics.js");
const call = async (b) => JSON.parse((await db.handler({ httpMethod: "POST", body: JSON.stringify(b) })).body || "{}");
const OWNER_CHAT = "8632288596";
const ist = () => new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10);
const days = (a, b) => Math.round((new Date(b + "T00:00:00") - new Date(a + "T00:00:00")) / 864e5);
const paid = (x) => (x.payments || []).reduce((a, p) => a + (Number(p.amount) || 0), 0);

exports.handler = async () => {
  try {
    const s = await L.settings();
    const r = await call({ action: "getPortfolio", user: "main", key: "logistics_v2" });
    const data = (r && r.data) || { shipments: [] };
    const today = ist(), lines = { del: [], pay: [], doc: [], fu: [] };
    let due = 0;
    (data.shipments || []).forEach(x => {
      if (x.cancelled) return;
      const d = x.date || (x.createdAt || "").slice(0, 10);
      const age = d ? days(d, today) : 0;
      const name = L.esc(x.customer || "—") + (x.invoiceNo ? " (Inv " + L.esc(x.invoiceNo) + ")" : "");
      if (!x.deliveredOn && age >= s.deliveryDays) lines.del.push("• " + name + " — " + age + " days, " + L.esc(x.transporter || "") + (x.lrNo ? " LR " + L.esc(x.lrNo) : ""));
      const bal = (Number(x.invoiceAmount) || 0) - paid(x);
      if (x.invoiceAmount && bal > 1 && age >= s.paymentDays) { lines.pay.push("• " + name + " — " + L.inr(bal) + " due, " + age + " days"); due += bal; }
      const types = new Set((x.files || []).map(f => f.kind));
      if (age >= s.docDays && !x.deliveredOn) { const miss = [["lr", "LR copy"], ["eway", "e-way bill"], ["invoice", "invoice"]].filter(k => !types.has(k[0])).map(k => k[1]); if (miss.length) lines.doc.push("• " + name + " — missing " + miss.join(", ")); }
      if (x.followUp && x.followUp <= today && !x.followUpDone) lines.fu.push("• " + name + (x.followUpNote ? " — " + L.esc(x.followUpNote) : ""));
    });
    const sec = (t, a) => a.length ? "\n\n<b>" + t + " (" + a.length + ")</b>\n" + a.slice(0, 15).join("\n") + (a.length > 15 ? "\n…and " + (a.length - 15) + " more" : "") : "";
    const body = sec("📞 Follow up today", lines.fu) + sec("🚚 Not delivered yet", lines.del) + sec("💰 Payment pending", lines.pay) + sec("📎 Documents missing", lines.doc);
    if (!body) return { statusCode: 200, body: "nothing due" };
    const head = "☀️ <b>Dispatch Register — " + today + "</b>" + (due ? "\nTotal payment pending: <b>" + L.inr(due) + "</b>" : "");
    const link = "\n\nOpen: https://rk-tracker-v2.netlify.app/lr/";
    await L.tgSend([s.prakashChat || OWNER_CHAT], head + body + link + "?user=prakash");
    const digest = [].concat(s.digestToOwner && s.prakashChat ? [OWNER_CHAT] : []).concat(s.digestToGroup ? [s.groupChat] : []);
    const summary = head + "\nPending deliveries: " + lines.del.length + " · Unpaid bills: " + lines.pay.length + " · Missing docs: " + lines.doc.length + " · Follow-ups today: " + lines.fu.length;
    if (digest.length) await L.tgSend(digest, summary);
  } catch (e) {}
  return { statusCode: 200, body: "ok" };
};
