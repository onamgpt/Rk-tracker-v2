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
    const today = ist(), lines = { del: [], pay: [], doc: [], fu: [], ord: [], mat: [] };
    const soon = new Date(Date.now() + 5.5 * 3600e3 + 3 * 864e5).toISOString().slice(0, 10);
    let due = 0;
    (data.shipments || []).forEach(x => {
      if (x.cancelled) return;
      const name = L.esc(x.customer || "—") + (x.invoiceNo ? " (Inv " + L.esc(x.invoiceNo) + ")" : x.orderNo ? " (PO " + L.esc(x.orderNo) + ")" : "");
      const d = x.dispatchedOn || (x.orderDate === undefined ? x.date : "");
      if (!d) {   // not dispatched yet: chase the order side
        const pend = (x.materials || []).filter(m => !m.received);
        if (x.expectedDispatch && x.expectedDispatch <= today) lines.ord.push("• " + name + " — dispatch was due " + x.expectedDispatch + " · " + L.esc(x.production || "Not started"));
        else if (x.expectedDispatch && x.expectedDispatch <= soon && (x.production || "Not started") === "Not started") lines.ord.push("• " + name + " — dispatch by " + x.expectedDispatch + ", production not started");
        if (pend.length && (!x.expectedDispatch || x.expectedDispatch <= soon)) lines.mat.push("• " + name + " — " + pend.map(m => L.esc(m.name) + (m.supplier ? " (" + L.esc(m.supplier) + ")" : "")).join(", "));
      } else {
      const age = days(d, today);
      if (!x.deliveredOn && age >= s.deliveryDays) lines.del.push("• " + name + " — " + age + " days, " + L.esc(x.transporter || "") + (x.lrNo ? " LR " + L.esc(x.lrNo) : ""));
      const bal = (Number(x.invoiceAmount) || 0) - paid(x);
      if (x.invoiceAmount && bal > 1 && age >= s.paymentDays) { lines.pay.push("• " + name + " — " + L.inr(bal) + " due, " + age + " days"); due += bal; }
      const types = new Set((x.files || []).map(f => f.kind));
      if (age >= s.docDays && !x.deliveredOn) { const miss = [["lr", "LR copy"], ["eway", "e-way bill"], ["invoice", "invoice"]].filter(k => !types.has(k[0])).map(k => k[1]); if (miss.length) lines.doc.push("• " + name + " — missing " + miss.join(", ")); }
      }
      if (x.followUp && x.followUp <= today && !x.followUpDone) lines.fu.push("• " + name + (x.followUpNote ? " — " + L.esc(x.followUpNote) : ""));
    });
    const sec = (t, a) => a.length ? "\n\n<b>" + t + " (" + a.length + ")</b>\n" + a.slice(0, 15).join("\n") + (a.length > 15 ? "\n…and " + (a.length - 15) + " more" : "") : "";
    const body = sec("📅 Orders due for dispatch", lines.ord) + sec("🧪 Materials still pending", lines.mat) + sec("📞 Follow up today", lines.fu) + sec("🚚 Not delivered yet", lines.del) + sec("💰 Payment pending", lines.pay) + sec("📎 Documents missing", lines.doc);
    if (!body) return { statusCode: 200, body: "nothing due" };
    const head = "☀️ <b>Orders & Dispatch — " + today + "</b>" + (due ? "\nTotal payment pending: <b>" + L.inr(due) + "</b>" : "");
    const link = "\n\nOpen: https://rk-tracker-v2.netlify.app/lr/";
    // Prakash: one email every morning (and Telegram too once his chat is known)
    if (s.prakashEmail && s.emailToPrakash !== false) {
      const html = "<div style='font-family:Arial,sans-serif;font-size:15px;line-height:1.5'>" +
        (head + body).replace(/\n/g, "<br>") + "<br><br><a href='https://rk-tracker-v2.netlify.app/lr/?user=prakash' style='background:#1d3557;color:#fff;padding:10px 16px;border-radius:8px;text-decoration:none'>Open Orders &amp; Dispatch</a></div>";
      try { await require("./mail.js").handler({ httpMethod: "POST", body: JSON.stringify({ to: s.prakashEmail, subject: "Orders & Dispatch — today's list (" + today + ")", html }) }); } catch (e) {}
    }
    if (s.prakashChat && s.telegramToPrakash !== false) await L.tgSend([s.prakashChat], head + body + link + "?user=prakash");
    const digest = [].concat(s.digestToOwner ? [OWNER_CHAT] : []).concat(s.digestToGroup ? [s.groupChat] : []);
    const summary = head + "\nOrders due: " + lines.ord.length + " · Materials pending: " + lines.mat.length + " · Pending deliveries: " + lines.del.length + " · Unpaid bills: " + lines.pay.length + " · Missing docs: " + lines.doc.length + " · Follow-ups today: " + lines.fu.length;
    if (digest.length) await L.tgSend(digest, summary);
  } catch (e) {}
  return { statusCode: 200, body: "ok" };
};
