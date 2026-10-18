// GST refund calculator for Onam Agarbathi.
//   Inverted duty (Rule 89(5)): agarbathi is taxed at 5% while inputs such as
//     perfumery compounds and packaging carry 12–18%, so input credit piles up.
//     Max refund = (inverted turnover × Net ITC ÷ adjusted total turnover)
//                  − (tax payable on inverted turnover × Net ITC ÷ ITC on inputs and input services)
//     Net ITC here = ITC on INPUTS (goods) only.
//   Exports under LUT (Rule 89(4)):
//     Refund = zero-rated turnover × Net ITC ÷ adjusted total turnover
//     Net ITC here = ITC on inputs AND input services (not capital goods).
// The claim is limited to the electronic credit ledger balance. Time limit:
// 2 years from the relevant date (inverted: due date of that period's return;
// exports of goods: date of export). All figures must come from the GST returns
// in the end — Tally pre-fill is an estimate. The CA files RFD-01.
const r0 = (n) => Math.round(Number(n) || 0);
const days = (a, b) => Math.round((new Date(b + "T00:00:00Z") - new Date(a + "T00:00:00Z")) / 864e5);
const addYears = (d, n) => { const x = new Date(d + "T00:00:00Z"); x.setUTCFullYear(x.getUTCFullYear() + n); return x.toISOString().slice(0, 10); };
const OUT_TAX = /(output|out\b|payable).*(cgst|sgst|igst|gst)|^(cgst|sgst|igst)\b/i;
const IN_TAX = /(input|in\b|itc|receivable).*(cgst|sgst|igst|gst)|^(cgst|sgst|igst)\b/i;
const isSales = (t) => /sales/i.test(t || "") && !/order|return|credit/i.test(t || "");
const isPurch = (t) => /purchase/i.test(t || "") && !/order|return|debit/i.test(t || "");

function compute(p) {
  const n = (k) => Number(p[k]) || 0;
  const att = n("adjTurnover"), itcIn = n("itcInputs"), itcSv = n("itcServices");
  const inv = { turnover: n("invertedTurnover"), taxPayable: n("taxOnInverted"), netItc: itcIn };
  inv.part1 = att ? inv.turnover * inv.netItc / att : 0;
  inv.part2 = (itcIn + itcSv) ? inv.taxPayable * (inv.netItc / (itcIn + itcSv)) : 0;
  inv.refund = Math.max(0, inv.part1 - inv.part2);
  const exp = { turnover: n("zeroRatedTurnover"), netItc: itcIn + itcSv };
  exp.refund = att ? Math.max(0, exp.turnover * exp.netItc / att) : 0;
  const total = inv.refund + exp.refund;
  const ledger = p.ledgerBalance === "" || p.ledgerBalance == null ? null : n("ledgerBalance");
  const claimable = ledger == null ? total : Math.min(total, ledger);
  return { inverted: { turnover: r0(inv.turnover), taxPayable: r0(inv.taxPayable), netItc: r0(inv.netItc), part1: r0(inv.part1), part2: r0(inv.part2), refund: r0(inv.refund) },
    exports: { turnover: r0(exp.turnover), netItc: r0(exp.netItc), refund: r0(exp.refund) }, total: r0(total), ledger, claimable: r0(claimable),
    cappedByLedger: ledger != null && total > ledger };
}

// relevant date and the 2-year limit for a monthly period "YYYY-MM"
function deadlines(period, p) {
  const [y, m] = period.split("-").map(Number);
  const nxt = new Date(Date.UTC(y, m, 20)).toISOString().slice(0, 10);            // GSTR-3B due 20th of the next month
  const out = { inverted: addYears(nxt, 2) };
  if (p && p.firstExportDate) out.exports = addYears(p.firstExportDate, 2);         // goods: from the date of export
  out.earliest = [out.inverted, out.exports].filter(Boolean).sort()[0];
  return out;
}

// Estimate a month's figures from the Tally Day Book (XML ledger lines if available) and the export register
function prefill(vouchers, exportReg, period) {
  const buyers = (((exportReg && exportReg.settings) || {}).buyers || []).map((b) => b.toLowerCase());
  const expInv = new Set(((exportReg && exportReg.list) || []).map((x) => String(x.invNo || "").toLowerCase()));
  const o = { invertedTurnover: 0, taxOnInverted: 0, zeroRatedTurnover: 0, itcInputs: 0, itcServices: 0, firstExportDate: "", basis: [] };
  let exact = 0, assumed = 0;
  (vouchers || []).filter((v) => !v.c && String(v.d || "").slice(0, 7) === period).forEach((v) => {
    const le = v.le || [];
    if (isSales(v.t)) {
      const isExp = /export/i.test(v.t || "") || expInv.has(String(v.n || "").toLowerCase()) || buyers.some((b) => b && (v.p || "").toLowerCase().includes(b));
      if (isExp) { o.zeroRatedTurnover += v.a || 0; if (!o.firstExportDate || v.d < o.firstExportDate) o.firstExportDate = v.d; return; }
      const tax = le.filter((l) => OUT_TAX.test(l.l) && l.a > 0).reduce((a, l) => a + l.a, 0);
      if (le.length) { exact++; o.taxOnInverted += tax; o.invertedTurnover += (v.a || 0) - tax; }
      else { assumed++; const taxable = (v.a || 0) / 1.05; o.invertedTurnover += taxable; o.taxOnInverted += (v.a || 0) - taxable; }
    } else if (le.length) {
      const itc = le.filter((l) => IN_TAX.test(l.l) && l.a < 0).reduce((a, l) => a + -l.a, 0);
      if (!itc) return;
      if (isPurch(v.t)) o.itcInputs += itc; else o.itcServices += itc;
    }
  });
  o.adjTurnover = o.invertedTurnover + o.zeroRatedTurnover;
  ["invertedTurnover", "taxOnInverted", "zeroRatedTurnover", "itcInputs", "itcServices", "adjTurnover"].forEach((k) => { o[k] = r0(o[k]); });
  o.basis = [exact ? exact + " sales with GST lines from Tally" : "", assumed ? assumed + " sales assumed at 5% GST (no ledger detail — send the Day Book as XML)" : "",
    !(vouchers || []).some((v) => (v.le || []).length) ? "ITC can't be estimated without the XML Day Book — enter it from GSTR-3B/2B" : ""].filter(Boolean);
  return o;
}

function summary(store, today) {
  const P = (store && store.periods) || {};
  const rows = Object.keys(P).sort().reverse().map((k) => { const p = P[k], c = compute(p), dl = deadlines(k, p); return { period: k, c, dl, left: dl.earliest ? days(today, dl.earliest) : null, status: p.status || "not filed" }; });
  const open = rows.filter((r) => r.status === "not filed" && r.c.claimable > 0);
  return { open: open.length, potential: r0(open.reduce((a, r) => a + r.c.claimable, 0)), filedPending: rows.filter((r) => r.status === "filed").length,
    nearest: open.filter((r) => r.left != null).sort((a, b) => a.left - b.left)[0] || null };
}

// monthly nudge on the 21st for last month (once GSTR-3B is in), and 60 / 30 / 7 days before a period's time limit
function reminders(store, today) {
  const out = [], P = (store && store.periods) || {};
  if (today.slice(8) === "21") { const m = new Date(today + "T00:00:00Z"); m.setUTCMonth(m.getUTCMonth() - 1); const pm = m.toISOString().slice(0, 7);
    out.push({ key: "nudge|" + pm, text: "GSTR-3B for " + pm + " should be filed by now — enter its ITC and turnover in 💰 GST refund to see the refund due (agarbathi's 5% vs 12–18% on inputs usually builds a refund)." }); }
  Object.keys(P).forEach((k) => { const p = P[k]; if ((p.status || "not filed") !== "not filed") return; const c = compute(p); if (c.claimable < 10000) return;
    const dl = deadlines(k, p), l = dl.earliest ? days(today, dl.earliest) : null;
    if ([60, 30, 7].includes(l)) out.push({ key: k + "|" + l, text: "GST refund for " + k + " (about ₹" + c.claimable.toLocaleString("en-IN") + ") must be filed within " + l + " days (by " + dl.earliest + ") — ask the CA to file RFD-01" }); });
  return out;
}
module.exports = { compute, deadlines, prefill, summary, reminders };
