// 9:15 IST each morning: summary to Ravi on Telegram; if no Tally export
// arrived for 2 working days, a polite reminder email to the accountant.
const T = require("./tally.js");
const db = require("./db.js");
const call = async (b) => JSON.parse((await db.handler({ httpMethod: "POST", body: JSON.stringify(b) })).body || "{}");
const kvGet = async (k) => { const r = await call({ action: "getPortfolio", user: "main", key: k }); return r && r.data != null ? r.data : null; };
const inr = (n) => "₹" + Math.round(Number(n) || 0).toLocaleString("en-IN");
const ist = (d) => new Date((d ? new Date(d).getTime() : Date.now()) + 5.5 * 3600e3);
exports.handler = async () => {
  try {
    const s = await T.settings();
    const meta = (await kvGet("tally_meta")) || {};
    const now = ist(); const day = now.getUTCDay();
    if (day === 0) return { statusCode: 200, body: "sunday" };
    const last = meta.lastUpload ? ist(meta.lastUpload) : null;
    const ageDays = last ? Math.floor((now - last) / 864e5) : 99;
    const stale = ageDays >= (day === 1 ? 3 : 2);
    if (stale) {
      await T.mail(s.accountantEmail, "Reminder: please upload today's Tally exports",
        "Good morning,\n\nThe tracker hasn't received the Tally export files for " + (last ? ageDays + " days" : "a while") +
        ".\nPlease export Day Book, Trial Balance, Receivables, Payables and Stock Summary (Alt+E → XML) and upload them at:\nhttps://rk-tracker-v2.netlify.app/tally/?user=maadhu\n\nThank you.");
    }
    const recv = (await kvGet("tally_recv")) || { rows: [] };
    const vch = ((await kvGet("tally_vouchers")) || { list: [] }).list;
    const y = new Date(now.getTime() - 864e5).toISOString().slice(0, 10), m = now.toISOString().slice(0, 7);
    const sales = vch.filter(v => /sales/i.test(v.t) && !/order|return|credit/i.test(v.t));
    const sumY = sales.filter(v => v.d === y).reduce((a, v) => a + (v.a || 0), 0);
    const sumM = sales.filter(v => v.d.slice(0, 7) === m).reduce((a, v) => a + (v.a || 0), 0);
    const over90 = (recv.rows || []).filter(r => (r.over || 0) > 90);
    const msg = "📒 <b>Tally — morning summary</b>" + (meta.vouchers ? " (data up to " + meta.vouchers.upTo + ")" : "") +
      "\nSales yesterday: <b>" + inr(sumY) + "</b> · this month: <b>" + inr(sumM) + "</b>" +
      "\nReceivables over 90 days: <b>" + inr(over90.reduce((a, r) => a + Math.abs(r.amt || 0), 0)) + "</b> (" + over90.length + " bills)" +
      (stale ? "\n⚠️ No Tally upload for " + ageDays + " days — reminder emailed to the accountant." : "") +
      "\nOpen: https://rk-tracker-v2.netlify.app/tally/";
    await T.tg(msg);
  } catch (e) {}
  return { statusCode: 200, body: "ok" };
};
