// Company health monitor — turns the Tally, bank, dispatch and field data into
// facts, ratios with green/amber/red, sudden-change alerts and admin checks.
// Every number here is computed (no AI). The advisor then explains them.
const SALES = (t) => /sales/i.test(t || "") && !/order|return|credit/i.test(t || "");
const CREDIT_NOTE = (t) => /credit\s*note|sales\s*return/i.test(t || "");
const PURCH = (t) => /purchase/i.test(t || "") && !/order|return|debit/i.test(t || "");
const DEBIT_NOTE = (t) => /debit\s*note|purchase\s*return/i.test(t || "");
// Onam's Tally uses custom voucher types like "HDFC - PYMT" — match the usual short forms too
const RECEIPT = (t) => /receipt|rcpt|\brect\b|\brcp\b/i.test(t || "");
const PAYMENT = (t) => /payment|pymt|\bpmt\b|\bpay\b/i.test(t || "");
const r0 = (n) => Math.round(Number(n) || 0);
const days = (a, b) => Math.round((new Date(b + "T00:00:00Z") - new Date(a + "T00:00:00Z")) / 864e5);
const addDays = (d, n) => new Date(new Date(d + "T00:00:00Z").getTime() + n * 864e5).toISOString().slice(0, 10);
const fyStart = (d) => { const y = +d.slice(0, 4), m = +d.slice(5, 7); return (m >= 4 ? y : y - 1) + "-04-01"; };
const SKIP_LEDGER = /bank|\bod\b|\bcc\b|cash|sales|purchase|cgst|sgst|igst|gst|tds|tcs|round|discount|debtor|creditor|capital|loan|stock/i;

function tbFind(rows, re) { return (rows || []).find((r) => re.test(r.name)); }
const net = (r, side) => (r ? (side === "dr" ? (r.dr || 0) - (r.cr || 0) : (r.cr || 0) - (r.dr || 0)) : null);

function light(v, good, bad, higherIsBetter) {
  if (v == null || !isFinite(v)) return "grey";
  if (higherIsBetter) return v >= good ? "green" : v <= bad ? "red" : "amber";
  return v <= good ? "green" : v >= bad ? "red" : "amber";
}

function compute(d, today, settings) {
  settings = settings || {};
  const V = ((d.vouchers || {}).list || []).filter((v) => !v.c && !v.o);
  const tb = (d.tb && d.tb.rows) || [], recv = (d.recv && d.recv.rows) || [], pay = (d.pay && d.pay.rows) || [], stock = (d.stock && d.stock.rows) || [];
  const fy = fyStart(today), mNow = today.slice(0, 7);

  // ---------- monthly flows from the Day Book ----------
  const M = {};
  const mo = (k) => M[k] || (M[k] = { m: k, sales: 0, creditNotes: 0, purchases: 0, debitNotes: 0, receipts: 0, payments: 0, nSales: 0 });
  V.forEach((v) => { const x = mo(v.d.slice(0, 7)), a = v.a || 0;
    if (SALES(v.t)) { x.sales += a; x.nSales++; } else if (CREDIT_NOTE(v.t)) x.creditNotes += a; else if (PURCH(v.t)) x.purchases += a; else if (DEBIT_NOTE(v.t)) x.debitNotes += a;
    else if (RECEIPT(v.t)) x.receipts += a; else if (PAYMENT(v.t)) x.payments += a; });
  const months = Object.keys(M).sort().slice(-13).map((k) => { const x = M[k]; return Object.assign({}, x, { netSales: r0(x.sales - x.creditNotes), netPurchases: r0(x.purchases - x.debitNotes) }); });
  const last = (n) => { const ks = Object.keys(M).sort().filter((k) => k < mNow).slice(-n); return ks.map((k) => M[k]); };
  const sum = (arr, f) => arr.reduce((a, x) => a + (x[f] || 0), 0);
  const in90 = V.filter((v) => days(v.d, today) <= 90);
  const sales90 = in90.filter((v) => SALES(v.t)).reduce((a, v) => a + v.a, 0) - in90.filter((v) => CREDIT_NOTE(v.t)).reduce((a, v) => a + v.a, 0);
  const purch90 = in90.filter((v) => PURCH(v.t)).reduce((a, v) => a + v.a, 0) - in90.filter((v) => DEBIT_NOTE(v.t)).reduce((a, v) => a + v.a, 0);
  const rec90 = in90.filter((v) => RECEIPT(v.t)).reduce((a, v) => a + v.a, 0), pay90 = in90.filter((v) => PAYMENT(v.t)).reduce((a, v) => a + v.a, 0);

  // ---------- balance sheet items (Trial Balance) ----------
  const debtorsTB = net(tbFind(tb, /^sundry debtors/i), "dr"), creditorsTB = net(tbFind(tb, /^sundry creditors/i), "cr");
  const debtors = debtorsTB != null ? debtorsTB : recv.reduce((a, r) => a + Math.abs(r.amt || 0), 0);
  const creditors = creditorsTB != null ? creditorsTB : pay.reduce((a, r) => a + Math.abs(r.amt || 0), 0);
  const cash = net(tbFind(tb, /^cash[- ]in[- ]hand/i), "dr") || 0;
  const bankBal = net(tbFind(tb, /^bank accounts/i), "dr") || 0;
  const od = Math.max(0, net(tbFind(tb, /^bank od|bank occ|overdraft/i), "cr") || 0);
  const duties = net(tbFind(tb, /^duties\s*&\s*taxes/i), "cr") || 0;
  const loans = net(tbFind(tb, /^loans\s*\(liabilit/i), "cr") || 0;
  const stockVal = stock.length ? stock.reduce((a, r) => a + (r.val || 0), 0) : (net(tbFind(tb, /^closing stock|^opening stock/i), "dr") || 0);
  const deposits = net(tbFind(tb, /^deposits?\s*\(asset|^loans\s*&\s*advances/i), "dr") || 0;
  const ca = Math.max(0, debtors) + cash + Math.max(0, bankBal) + stockVal + deposits;
  const cl = Math.max(0, creditors) + Math.max(0, duties) + od + Math.max(0, -bankBal);
  // flow-based ratios need ~90 days of Day Book; otherwise they'd be misleading
  const firstD = V.length ? V.reduce((m, v) => (v.d < m ? v.d : m), V[0].d) : today;
  const coverage = days(firstD, today), enough = coverage >= 80;
  const ratios = {
    currentRatio: cl ? ca / cl : null,
    dso: enough && sales90 > 0 ? debtors / sales90 * 90 : null,
    dpo: enough && purch90 > 0 ? creditors / purch90 * 90 : null,
    stockDays: enough && purch90 > 0 ? stockVal / purch90 * 90 : null,
    collection: enough && sales90 > 0 ? rec90 / sales90 * 100 : null,
    purchaseToSales: enough && sales90 > 0 ? purch90 / sales90 * 100 : null,
    odUse: settings.odLimit ? od / settings.odLimit * 100 : null,
    recv90plus: debtors > 0 ? recv.filter((r) => (r.over || 0) > 90).reduce((a, r) => a + Math.abs(r.amt || 0), 0) / Math.max(1, recv.reduce((a, r) => a + Math.abs(r.amt || 0), 0)) * 100 : null,
    pay90plus: pay.length ? pay.filter((r) => (r.over || 0) > 90).reduce((a, r) => a + Math.abs(r.amt || 0), 0) / Math.max(1, pay.reduce((a, r) => a + Math.abs(r.amt || 0), 0)) * 100 : null,
  };
  ratios.cashCycle = ratios.dso != null && ratios.stockDays != null && ratios.dpo != null ? ratios.dso + ratios.stockDays - ratios.dpo : null;
  const lights = {
    currentRatio: light(ratios.currentRatio, 1.33, 1.0, true), dso: light(ratios.dso, 60, 120, false), dpo: light(ratios.dpo, 60, 120, false),
    stockDays: light(ratios.stockDays, 60, 120, false), collection: light(ratios.collection, 90, 70, true), purchaseToSales: light(ratios.purchaseToSales, 65, 85, false),
    odUse: light(ratios.odUse, 75, 95, false), recv90plus: light(ratios.recv90plus, 15, 35, false), pay90plus: light(ratios.pay90plus, 15, 35, false), cashCycle: light(ratios.cashCycle, 90, 180, false),
  };

  // ---------- profit (from Trial Balance groups, year to date) ----------
  const g = (re, side) => net(tbFind(tb, re), side) || 0;
  const pl = { sales: g(/^sales accounts/i, "cr"), purchases: g(/^purchase accounts/i, "dr"), directExp: g(/^direct expenses/i, "dr"), indirectExp: g(/^indirect expenses/i, "dr"),
    directInc: g(/^direct incomes/i, "cr"), indirectInc: g(/^indirect incomes/i, "cr"), openingStock: g(/^opening stock/i, "dr") || Number(settings.openingStock) || 0, closingStock: stockVal };
  pl.grossProfit = pl.sales + pl.directInc + pl.closingStock - pl.openingStock - pl.purchases - pl.directExp;
  pl.netProfit = pl.grossProfit + pl.indirectInc - pl.indirectExp;
  pl.grossMargin = pl.sales ? pl.grossProfit / pl.sales * 100 : null;
  pl.netMargin = pl.sales ? pl.netProfit / pl.sales * 100 : null;
  const hasP = !!tbFind(tb, /^purchase accounts/i), hasS = !!tbFind(tb, /^sales accounts/i);
  pl.reliable = hasP && hasS && pl.grossMargin != null && Math.abs(pl.grossMargin) <= 60;
  pl.note = !hasS || !hasP ? "The Trial Balance received doesn't include " + (!hasS ? "Sales Accounts" : "Purchase Accounts") + " — ask Maadhu for the full Trial Balance from 1 April to today (all groups) to see real profit."
    : !pl.reliable ? "Profit looks implausible (" + Math.round(pl.grossMargin) + "% gross margin) — the Trial Balance and stock figures are probably for different periods. Ask for TB and Stock Summary both from 1 April to today."
    : !pl.openingStock ? "Opening stock unknown — profit is approximate until it's entered below." : stock.length ? "" : "No Stock Summary uploaded — closing stock taken as zero.";

  // ---------- alerts: sudden changes and red flags ----------
  const alerts = [];
  const prev3 = last(3);
  const dayOfMonth = +today.slice(8, 10), dim = new Date(+today.slice(0, 4), +today.slice(5, 7), 0).getDate();
  const proRate = (x) => x / Math.max(1, dayOfMonth) * dim;
  const cur = M[mNow];
  if (cur && prev3.length >= 2 && dayOfMonth >= 10) {
    [["purchases", "Purchases"], ["sales", "Sales"], ["payments", "Payments"], ["receipts", "Collections"]].forEach(([f, label]) => {
      const avg = sum(prev3, f) / prev3.length, now = proRate(cur[f]);
      if (avg > 50000 && now > avg * 1.3) alerts.push({ sev: f === "purchases" || f === "payments" ? "amber" : "green", text: label + " this month are heading for " + r0(now) + " — " + r0((now / avg - 1) * 100) + "% above the last 3 months' average (" + r0(avg) + ")" });
      if (avg > 50000 && now < avg * 0.7) alerts.push({ sev: f === "sales" || f === "receipts" ? "red" : "green", text: label + " this month are heading for " + r0(now) + " — " + r0((1 - now / avg) * 100) + "% below the 3-month average (" + r0(avg) + ")" });
    });
    const sAvg = sum(prev3, "sales") / prev3.length, pAvg = sum(prev3, "purchases") / prev3.length;
    if (sAvg > 0 && proRate(cur.purchases) / Math.max(1, proRate(cur.sales)) > 1.3 * (pAvg / sAvg)) alerts.push({ sev: "red", text: "Purchases are rising much faster than sales this month — stock building up, a price rise, or a large one-off order?" });
  }
  // concentration
  const bySum = (list, pred) => { const o = {}; list.filter((v) => pred(v.t)).forEach((v) => { if (v.p) o[v.p] = (o[v.p] || 0) + v.a; }); return Object.keys(o).map((k) => ({ p: k, a: o[k] })).sort((a, b) => b.a - a.a); };
  const topCust = bySum(in90, SALES), topSupp = bySum(in90, PURCH), paidTo = bySum(in90, PAYMENT);
  if (topCust.length && sales90 > 0 && topCust[0].a / sales90 > 0.3) alerts.push({ sev: "amber", text: topCust[0].p + " is " + r0(topCust[0].a / sales90 * 100) + "% of sales in the last 90 days — high dependence on one customer" });
  // expense spikes by ledger (needs XML ledger lines)
  const led = {};
  V.forEach((v) => (v.le || []).forEach((l) => { if (l.a < 0 && l.l !== v.p && !SKIP_LEDGER.test(l.l)) { const k = l.l, m = v.d.slice(0, 7); (led[k] = led[k] || {})[m] = (led[k][m] || 0) + -l.a; } }));
  const spikes = [];
  Object.keys(led).forEach((k) => { const ms = led[k], prevKs = Object.keys(ms).filter((m) => m < mNow).sort().slice(-3);
    if (prevKs.length < 2) return; const avg = prevKs.reduce((a, m) => a + ms[m], 0) / prevKs.length, now = ms[mNow] || 0;
    if (now > 25000 && now > avg * 1.5) spikes.push({ ledger: k, now: r0(now), avg: r0(avg) }); });
  spikes.sort((a, b) => b.now - b.avg - (a.now - a.avg)).slice(0, 6).forEach((x) => alerts.push({ sev: "amber", text: "Expense spike: " + x.ledger + " " + x.now + " this month vs " + x.avg + " average" }));
  // balance sheet red flags
  const diff = tbFind(tb, /difference in opening balances/i);
  if (diff && Math.abs((diff.dr || 0) - (diff.cr || 0)) > 1) alerts.push({ sev: "red", text: "Trial Balance shows a 'Difference in opening balances' of " + r0(Math.abs(diff.dr - diff.cr)) + " — last year's closing balances weren't carried forward correctly; the balance sheet won't tally until fixed" });
  if (bankBal < 0 && !od) alerts.push({ sev: "amber", text: "Bank Accounts group has a credit (overdrawn) balance of " + r0(-bankBal) });
  tb.forEach((r) => { if (/salary payable|tds.*payable|gst.*payable/i.test(r.name) && (r.dr || 0) - (r.cr || 0) > 100000) alerts.push({ sev: "amber", text: r.name + " shows a debit balance of " + r0(r.dr - r.cr) + " — a payable can't normally be in debit; check entries" }); });
  if (cash > 500000) alerts.push({ sev: "amber", text: "Cash in hand is " + r0(cash) + " — high for a company; auditors question large cash balances" });

  // ---------- admin monitoring ----------
  const meta = d.meta || {}, age = (iso) => (iso ? days(new Date(new Date(iso).getTime() + 5.5 * 3600e3).toISOString().slice(0, 10), today) : null);
  const audit = (d.audit && d.audit.open) || [];
  const openA = audit.filter((f) => f.status !== "reviewed");
  const C = require("./tally-compliance.js"), comp = d.comp || {};
  const occ = comp.since ? C.occurrences(comp.items || C.DEFAULT_ITEMS, comp.since, today) : [];
  const compOver = occ.filter((o) => !(comp.done || {})[o.key] && o.due < today);
  const compDone = occ.filter((o) => (comp.done || {})[o.key]);
  const onTime = compDone.filter((o) => comp.done[o.key].at.slice(0, 10) <= o.due).length;
  const ship = ((d.logistics || {}).shipments || []).filter((x) => !x.cancelled);
  const lateDispatch = ship.filter((x) => !x.dispatchedOn && x.expectedDispatch && x.expectedDispatch < today);
  const notReady = ship.filter((x) => !x.dispatchedOn && x.expectedDispatch && x.expectedDispatch <= addDays(today, 3) && (x.production || "Not started") !== "Ready");
  const field = {}; Object.keys(d.locFiles || {}).forEach((n) => { const f = d.locFiles[n] || []; field[n] = f.filter((v) => days(v.date, today) <= 7).length; });
  const admin = {
    dataAge: { dayBook: age(meta.vouchers && meta.vouchers.at), trialBalance: age(meta.tb && meta.tb.at), receivables: age(meta.recv && meta.recv.at), payables: age(meta.pay && meta.pay.at), stock: age(meta.stock && meta.stock.at) },
    auditOpen: { high: openA.filter((f) => f.sev === "high").length, total: openA.length, oldestDays: openA.length ? Math.max(...openA.map((f) => age(f.found) || 0)) : 0 },
    compliance: { overdue: compOver.map((o) => o.name + " (" + o.period + ", due " + o.due + ")"), onTimePct: compDone.length ? r0(onTime / compDone.length * 100) : null, done: compDone.length },
    dispatch: { late: lateDispatch.length, lateList: lateDispatch.slice(0, 6).map((x) => (x.customer || "?") + " due " + x.expectedDispatch), productionNotReady: notReady.length },
    fieldVisits7d: field,
  };
  // ---------- cross-checks ----------
  const invNos = new Set(V.filter((v) => SALES(v.t)).map((v) => String(v.n || "").replace(/\s/g, "").toLowerCase()));
  const dispatchedNoInvoice = ship.filter((x) => x.dispatchedOn && days(x.dispatchedOn, today) > 3 && x.invoiceNo && !invNos.has(String(x.invoiceNo).replace(/\s/g, "").toLowerCase()));
  const cross = { dispatchedNotInvoiced: dispatchedNoInvoice.length, list: dispatchedNoInvoice.slice(0, 6).map((x) => (x.customer || "?") + " inv " + x.invoiceNo + " dispatched " + x.dispatchedOn) };

  // ---------- bank movement (from statements) ----------
  const bank = (d.bank && d.bank.accounts) || {};
  const bankFlow = Object.keys(bank).map((n) => { const t = bank[n].txns || []; const l30 = t.filter((x) => days(x.d, today) <= 30);
    return { account: n, in30: r0(l30.reduce((a, x) => a + (x.cr || 0), 0)), out30: r0(l30.reduce((a, x) => a + (x.dr || 0), 0)), balance: t.length ? t[t.length - 1].bal : null, upTo: t.length ? t[t.length - 1].d : null }; });

  // ---------- simple 4-week cash view ----------
  const inflow = recv.filter((r) => r.due && r.due <= addDays(today, 28)).reduce((a, r) => a + Math.abs(r.amt || 0), 0);
  const outflow = pay.filter((r) => r.due && r.due <= addDays(today, 28)).reduce((a, r) => a + Math.abs(r.amt || 0), 0);

  // ---------- score ----------
  const pts = { green: 10, amber: 5, red: 0 }, ls = Object.values(lights).filter((x) => x !== "grey");
  let score = ls.length ? ls.reduce((a, x) => a + pts[x], 0) / ls.length * 10 : null;
  if (score != null) { score -= Math.min(20, alerts.filter((a) => a.sev === "red").length * 5 + admin.auditOpen.high * 2 + admin.compliance.overdue.length * 3); score = Math.max(0, r0(score)); }

  let exportsSummary = null;
  try { if (d.exports && (d.exports.list || []).length) exportsSummary = require("./tally-exports.js").summary(d.exports, today); } catch (e) {}
  if (exportsSummary && exportsSummary.overdue) alerts.push({ sev: "red", text: exportsSummary.overdue + " export invoice(s) past the RBI realisation deadline — under LUT, IGST with interest may become payable" });
  return { today, fy, months, ratios, lights, pl, alerts, score, admin, cross, bankFlow, exports: exportsSummary,
    balances: { debtors: r0(debtors), creditors: r0(creditors), cash: r0(cash), bank: r0(bankBal), od: r0(od), stock: r0(stockVal), duties: r0(duties), loans: r0(loans) },
    last90: { sales: r0(sales90), purchases: r0(purch90), receipts: r0(rec90), payments: r0(pay90) },
    cash4w: { expectedIn: r0(inflow), dueOut: r0(outflow) },
    topCustomers: topCust.slice(0, 8).map((x) => ({ p: x.p, a: r0(x.a) })), topSuppliers: topSupp.slice(0, 8).map((x) => ({ p: x.p, a: r0(x.a) })), paidTo: paidTo.slice(0, 10).map((x) => ({ p: x.p, a: r0(x.a) })),
    overdueCustomers: recv.filter((r) => (r.over || 0) > 60).sort((a, b) => Math.abs(b.amt) - Math.abs(a.amt)).slice(0, 10).map((r) => ({ p: r.party, a: r0(Math.abs(r.amt)), days: r.over, ref: r.ref })),
    overdueSuppliers: pay.filter((r) => (r.over || 0) > 60).sort((a, b) => (b.over || 0) - (a.over || 0)).slice(0, 10).map((r) => ({ p: r.party, a: r0(Math.abs(r.amt)), days: r.over, ref: r.ref })),
    coverageDays: coverage,
    dataNote: (V.some((v) => v.le) ? "" : "Day Book has no ledger detail yet (needs XML) — expense spikes can't be checked. ") +
      (enough ? "" : "Day Book covers only " + coverage + " days — collection, payment and stock-day ratios need about 90 days (ask Maadhu for the Day Book from 1 April once). ") };
}

async function load(kvGet) {
  const keys = ["tally_vouchers", "tally_tb", "tally_recv", "tally_pay", "tally_stock", "tally_meta", "tally_bank", "tally_audit", "tally_compliance", "logistics_v2", "tally_health_settings", "export_register"];
  const v = await Promise.all(keys.map(kvGet));
  const d = { vouchers: v[0], tb: v[1], recv: v[2], pay: v[3], stock: v[4], meta: v[5], bank: v[6], audit: v[7], comp: v[8], logistics: v[9], settings: v[10] || {}, exports: v[11] };
  try { const L = require("./loc-lib.js"); d.locFiles = {}; for (const p of Object.values(L.PEOPLE)) d.locFiles[p.name] = await L.loadFile(p.name); } catch (e) {}
  return d;
}
module.exports = { compute, load, fyStart };
