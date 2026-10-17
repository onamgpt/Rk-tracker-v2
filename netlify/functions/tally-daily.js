// 9:15 IST each morning: summary to Ravi on Telegram. If any Tally report or
// bank statement hasn't arrived for 3+ days, a reminder email to the accountant
// listing exactly what's missing — at most once every 3 days.
const T = require("./tally.js");
const db = require("./db.js");
const call = async (b) => JSON.parse((await db.handler({ httpMethod: "POST", body: JSON.stringify(b) })).body || "{}");
const kvGet = async (k) => { const r = await call({ action: "getPortfolio", user: "main", key: k }); return r && r.data != null ? r.data : null; };
const inr = (n) => "₹" + Math.round(Number(n) || 0).toLocaleString("en-IN");
const ist = (d) => new Date((d ? new Date(d).getTime() : Date.now()) + 5.5 * 3600e3);
async function summary() {
  try {
    const s = await T.settings();
    const meta = (await kvGet("tally_meta")) || {};
    const now = ist(); const day = now.getUTCDay();
    if (day === 0) return { statusCode: 200, body: "sunday" };
    // Which documents haven't arrived (by email or upload) for 3+ days?
    const DOCS = [["vouchers", "Day Book"], ["tb", "Trial Balance"], ["recv", "Receivables (Outstandings)"], ["pay", "Payables (Outstandings)"], ["stock", "Stock Summary"]];
    const age = (iso) => iso ? Math.floor((now - ist(iso)) / 864e5) : null;
    // the exact period to send: from the day after what we already have, up to today
    const today = now.toISOString().slice(0, 10);
    const fyStart = (now.getUTCMonth() >= 3 ? now.getUTCFullYear() : now.getUTCFullYear() - 1) + "-04-01";
    const nextDay = (d) => new Date(new Date(d + "T00:00:00Z").getTime() + 864e5).toISOString().slice(0, 10);
    const fmt = (d) => new Date(d + "T00:00:00Z").toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
    const range = (from) => "from " + fmt(from) + " to " + fmt(today);
    const missing = [];
    DOCS.forEach(([k, label]) => {
      const a2 = age(meta[k] && meta[k].at); if (!(a2 == null || a2 >= 3)) return;
      let need;
      if (k === "vouchers") { const upTo = meta.vouchers && meta.vouchers.upTo; need = range(upTo && upTo < today ? nextDay(upTo) : fyStart); }
      else if (k === "tb") need = "for " + fmt(fyStart) + " to " + fmt(today) + " (as on today)";
      else need = "as on " + fmt(today);
      missing.push(label + " — " + need + (a2 == null ? " (never received)" : " (last received " + a2 + " days ago)"));
    });
    const bank = (await kvGet("tally_bank")) || { accounts: {} };
    const accs = Object.keys(bank.accounts || {});
    if (!accs.length) missing.push("Bank statements (Excel/CSV), every account — " + range(fyStart) + " (never received)");
    accs.forEach((n) => {
      const a2 = age(bank.accounts[n].updated); if (!(a2 == null || a2 >= 3)) return;
      const t = bank.accounts[n].txns || [], lastD = t.length ? t[t.length - 1].d : null;
      missing.push("Bank statement: " + n + " — " + range(lastD && lastD < today ? nextDay(lastD) : fyStart) + " (last received " + a2 + " days ago)");
    });
    // Remind at most once every 3 days, and only while something is missing
    const rem = (await kvGet("tally_reminder")) || {};
    const remAge = rem.at ? Math.floor((now - ist(rem.at)) / 864e5) : 99;
    const stale = missing.length > 0 && remAge >= 3;
    if (stale) {
      await T.mail(s.accountantEmail, "Reminder: Tally documents pending (" + missing.length + ")",
        "Good morning Maadhu,\n\nThe tracker has not received these documents for 3 days or more:\n\n" + missing.map((x) => "  • " + x).join("\n") +
        "\n\nPlease send them in either way:\n  1. Email them to onamagarbathi@gmail.com with \"backup\" in the subject (Excel/XML attachments), or\n  2. Upload at https://rk-tracker-v2.netlify.app/tally/?user=maadhu" +
        "\n\nBank statements: download as Excel or CSV from net banking (password-protected PDFs can't be read) and upload under 🏦 Bank statements.\n\nThank you.");
      await call({ action: "savePortfolio", user: "main", key: "tally_reminder", data: { at: new Date().toISOString(), missing } });
    }
    const ageDays = missing.length;
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
      (stale ? "\n⚠️ Reminder emailed to Maadhu — pending: " + missing.map((x) => x.split(" — ")[0]).join(", ") + "." : missing.length ? "\n⏳ Pending from Maadhu: " + missing.map((x) => x.split(" — ")[0]).join(", ") + " (next reminder in " + Math.max(0, 3 - remAge) + " day(s))." : "") +
      "\nOpen: https://rk-tracker-v2.netlify.app/tally/";
    await T.tg(msg);
  } catch (e) {}
}
exports.summary = summary;
// Scheduled 9:15 IST: read Maadhu's backup email first (background), which then sends the summary.
exports.handler = async () => {
  const base = process.env.URL || "https://rk-tracker-v2.netlify.app";
  // #Trackerv23 emails → tracker, and team location emails → Team Locations
  try { await fetch(base + "/.netlify/functions/gmail-daily-background", { method: "POST", headers: { "Content-Type": "application/json", "x-run-key": T.runKey() }, body: JSON.stringify({ job: "morning" }) }); } catch (e) {}
  try {
    const r = await fetch(base + "/.netlify/functions/tally-mail-background", { method: "POST", headers: { "Content-Type": "application/json", "x-run-key": T.runKey() }, body: JSON.stringify({ notify: true }) });
    if (r.status >= 400) await summary();
  } catch (e) { await summary(); }
  return { statusCode: 200, body: "ok" };
};
