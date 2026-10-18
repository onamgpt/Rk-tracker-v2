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
  try { await compliance(); } catch (e) {}
  // the AI advisor writes the morning brief (deeper review on Mondays)
  try { const base = process.env.URL || "https://rk-tracker-v2.netlify.app";
    await fetch(base + "/.netlify/functions/tally-advisor-background", { method: "POST", headers: { "Content-Type": "application/json", "x-run-key": T.runKey() }, body: "{}" }); } catch (e) {}
}
exports.summary = summary;

// Statutory due dates, licence / insurance / asset renewals, MSME 45-day rule, bank reconciliation
async function compliance() {
  const C = require("./tally-compliance.js");
  const s = await T.settings();
  const today = ist().toISOString().slice(0, 10);
  const st = (await kvGet("tally_compliance")) || {};
  if (!st.since) { st.since = today; await call({ action: "savePortfolio", user: "main", key: "tally_compliance", data: st }); }
  const fmt = (d) => new Date(d + "T00:00:00Z").toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
  const when = (l) => l > 0 ? "in " + l + " day" + (l > 1 ? "s" : "") : l === 0 ? "TODAY" : "OVERDUE by " + -l + " day" + (l < -1 ? "s" : "");
  // 1) statutory due dates → Maadhu and Ravi
  const dueAll = C.dueReminders(st, today);
  const due = dueAll.filter((d) => d.who !== "ravi"), mine = dueAll.filter((d) => d.who === "ravi");
  if (mine.length) {
    const lines = mine.map((d) => "• " + d.name + " — " + d.period + " (" + when(d.left) + ")");
    await T.mail(s.ownerEmail, "Ask your CA: " + mine.map((d) => d.name.replace(/^Ask CA: /, "")).join("; ").slice(0, 120), "Time to check with your CA:\n\n" + lines.join("\n") + "\n\nMark done in Tally → 📅 Compliance: https://rk-tracker-v2.netlify.app/tally/");
    await T.tg("📞 <b>Ask your CA</b>\n" + lines.join("\n"));
    st.sent = st.sent || {}; mine.forEach((d) => { st.sent[d.key] = today; });
    await call({ action: "savePortfolio", user: "main", key: "tally_compliance", data: st });
  }
  if (due.length) {
    const lines = due.map((d) => "• " + d.name + " — " + d.period + " — due " + fmt(d.due) + " (" + when(d.left) + ")");
    await T.mail(s.accountantEmail, "Compliance due: " + due.map((d) => d.name.split(" (")[0]).join(", "),
      "Good morning Maadhu,\n\nThese are due:\n\n" + lines.join("\n") + "\n\nWhen done, please mark each one as filed and upload the challan / acknowledgement at:\nhttps://rk-tracker-v2.netlify.app/tally/?user=maadhu  (📅 Compliance)\n\nThank you.");
    await T.mail(s.ownerEmail, "Compliance due (" + due.length + ")", "Reminder sent to Maadhu:\n\n" + lines.join("\n") + "\n\nhttps://rk-tracker-v2.netlify.app/tally/");
    await T.tg("📅 <b>Compliance due</b>\n" + lines.join("\n") + "\nReminder emailed to Maadhu.");
    st.sent = st.sent || {}; due.forEach((d) => { st.sent[d.key] = today; });
    const keep = {}; Object.keys(st.sent).forEach((k) => { if (C.days(st.sent[k], today) < 120) keep[k] = st.sent[k]; }); st.sent = keep;
    await call({ action: "savePortfolio", user: "main", key: "tally_compliance", data: st });
  }
  // 2) licences, insurance, asset insurance / AMC → Ravi
  const lic = ((await kvGet("tally_licences")) || {}).list || [], assets = ((await kvGet("tally_assets")) || {}).list || [];
  st.expSent = st.expSent || {};
  const exp = C.expiryReminders(lic, today, "Licence/insurance").concat(C.expiryReminders(assets, today, "Asset")).filter((x) => st.expSent[x.name + "|" + x.date] !== today);
  if (exp.length) {
    exp.forEach((x) => { st.expSent[x.name + "|" + x.date] = today; });
    const keepE = {}; Object.keys(st.expSent).forEach((k) => { if (C.days(st.expSent[k], today) < 60) keepE[k] = st.expSent[k]; }); st.expSent = keepE;
    await call({ action: "savePortfolio", user: "main", key: "tally_compliance", data: st });
    const lines = exp.map((x) => "• " + x.name + (x.number ? " (" + x.number + ")" : "") + " — expires " + fmt(x.date) + " (" + when(x.left) + ")");
    await T.mail(s.ownerEmail, "Renewals due: " + exp.map((x) => x.name).join(", ").slice(0, 120), "These need renewal:\n\n" + lines.join("\n") + "\n\nRegister: https://rk-tracker-v2.netlify.app/tally/ (📜 Licences, 🏭 Assets)");
    await T.tg("📜 <b>Renewals due</b>\n" + lines.join("\n"));
  }
  // 2b) export register: realisation deadlines, shipping bills, eBRC, LUT
  try {
    const X = require("./tally-exports.js");
    const reg = (await kvGet("export_register")) || { list: [] };
    reg.sent = reg.sent || {};
    const ex = X.reminders(reg, today).filter((r) => !reg.sent[r.key]);
    if (ex.length) {
      const lines = ex.map((r) => (r.sev === "high" ? "🔴 " : "🟠 ") + r.text);
      await T.mail(s.ownerEmail, "Export follow-up (" + ex.length + ")", lines.join("\n\n") + "\n\nExport register: https://rk-tracker-v2.netlify.app/tally/ (🌍 Exports)");
      await T.tg("🌍 <b>Exports</b>\n" + lines.join("\n"));
      ex.forEach((r) => { reg.sent[r.key] = today; });
      const keepX = {}; Object.keys(reg.sent).forEach((k) => { if (C.days(reg.sent[k], today) < 400) keepX[k] = reg.sent[k]; }); reg.sent = keepX;
      await call({ action: "savePortfolio", user: "main", key: "export_register", data: reg });
    }
  } catch (e) {}
  // 2c) professional bills: due soon / overdue, and last month's TDS to deposit
  try {
    const PB = require("./tally-profbills.js");
    const pr = (await kvGet("prof_bills")) || { list: [] }; pr.sent = pr.sent || {};
    const rem = PB.reminders(pr.list, today).filter((r) => !pr.sent[r.key]);
    if (rem.length) {
      const lines = rem.map((r) => "• " + r.text);
      await T.mail(s.accountantEmail, "Professional bills to pay", "Hello Maadhu,\n\n" + lines.join("\n") + "\n\nMark them paid at https://rk-tracker-v2.netlify.app/tally/?user=maadhu (🧾 Prof. bills)\n\nThank you.");
      await T.tg("🧾 <b>Professional bills</b>\n" + lines.join("\n"));
      rem.forEach((r) => { pr.sent[r.key] = today; });
      const keepP = {}; Object.keys(pr.sent).forEach((k) => { if (C.days(pr.sent[k], today) < 120) keepP[k] = pr.sent[k]; }); pr.sent = keepP;
      await call({ action: "savePortfolio", user: "main", key: "prof_bills", data: pr });
    }
  } catch (e) {}
  // 2d) GST refund: monthly nudge and time-limit warnings
  try {
    const GR = require("./tally-gstrefund.js");
    const gs = (await kvGet("gst_refund")) || { periods: {} }; gs.sent = gs.sent || {};
    const rem = GR.reminders(gs, today).filter((r) => !gs.sent[r.key]);
    if (rem.length) {
      await T.tg("💰 <b>GST refund</b>\n" + rem.map((r) => "• " + r.text).join("\n"));
      await T.mail(s.ownerEmail, "GST refund", rem.map((r) => "• " + r.text).join("\n") + "\n\nhttps://rk-tracker-v2.netlify.app/tally/ (💰 GST refund)");
      rem.forEach((r) => { gs.sent[r.key] = today; });
      await call({ action: "savePortfolio", user: "main", key: "gst_refund", data: gs });
    }
  } catch (e) {}
  // 3) MSME suppliers unpaid beyond 45 days (section 43B(h)) and 4) bank reconciliation → audit findings
  const flags = [];
  const pay = (await kvGet("tally_pay")) || { rows: [] };
  C.msmeDues(pay.rows, st.msme || [], today).filter((x) => x.age > 45).forEach((x) => flags.push({ kind: "MSME unpaid > 45 days", sev: "high", d: x.date, t: "Bill", n: x.ref || "", p: x.party, a: Math.round(x.amt),
    note: "MSME supplier bill is " + x.age + " days old (should have been paid by " + fmt(x.payBy) + ") — under section 43B(h) it can't be claimed as an expense until paid", key: "MSME|" + x.party + "|" + (x.ref || x.date) }));
  const bank = (await kvGet("tally_bank")) || { accounts: {} }, vch = ((await kvGet("tally_vouchers")) || {}).list || [];
  Object.keys(st.reconMap || {}).forEach((acc) => {
    const A = bank.accounts[acc]; if (!A) return;
    const r = C.reconcile(A.txns, vch, st.reconMap[acc]);
    r.notInTally.filter((x) => C.days(x.d, today) > 3).forEach((x) => flags.push({ kind: "In bank, not in Tally", sev: "medium", d: x.d, t: acc, n: x.ref || "", p: x.desc, a: Math.round(x.amt),
      note: (x.dir === "in" ? "Money received " : "Money paid ") + "in the bank but no matching entry in Tally ledger " + st.reconMap[acc], key: "RECB|" + acc + "|" + x.d + "|" + x.amt + "|" + x.dir }));
    r.notInBank.forEach((x) => flags.push({ kind: "In Tally, not in bank", sev: "medium", d: x.d, t: x.t, n: x.n, p: x.p, a: Math.round(x.amt),
      note: (x.dir === "in" ? "Receipt" : "Payment") + " entered in Tally (" + st.reconMap[acc] + ")" + (x.ch ? ", cheque " + x.ch : "") + " but not seen in the bank statement after 7 days — uncleared or wrong entry?", key: "RECT|" + acc + "|" + x.d + "|" + x.amt + "|" + (x.n || "") }));
  });
  if (flags.length) await T.reportFlags(flags, "Compliance & bank check");
}
exports.compliance = compliance;
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
