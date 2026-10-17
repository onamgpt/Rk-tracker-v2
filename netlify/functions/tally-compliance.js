// Compliance for Onam Agarbathi: statutory due dates, licences & insurance,
// fixed assets, the MSME 45-day payment rule, and bank reconciliation.
// Standard Indian due dates are pre-filled and EDITABLE — the CA should
// confirm which apply. Nothing here files anything; it reminds and records.
const isoAdd = (d, n) => new Date(new Date(d + "T00:00:00Z").getTime() + n * 864e5).toISOString().slice(0, 10);
const days = (a, b) => Math.round((new Date(b + "T00:00:00Z") - new Date(a + "T00:00:00Z")) / 864e5);
const pad = (n) => String(n).padStart(2, "0");
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// kind "monthly": due on `day` of the month after the period (March → `marchDue` if set)
// kind "dates":   fixed MM-DD dates each year, with a period label
const DEFAULT_ITEMS = [
  { id: "gstr1", name: "GSTR-1 (outward supplies)", cat: "GST", kind: "monthly", day: 11, on: true },
  { id: "gstr3b", name: "GSTR-3B + GST payment", cat: "GST", kind: "monthly", day: 20, on: true },
  { id: "gstr9", name: "GSTR-9 / 9C annual return", cat: "GST", kind: "dates", dates: [["12-31", "FY ending March"]], on: true },
  { id: "tdspay", name: "TDS / TCS payment", cat: "Income tax", kind: "monthly", day: 7, marchDue: "04-30", on: true },
  { id: "tdsret", name: "TDS returns (24Q / 26Q)", cat: "Income tax", kind: "dates", dates: [["07-31", "Q1 Apr–Jun"], ["10-31", "Q2 Jul–Sep"], ["01-31", "Q3 Oct–Dec"], ["05-31", "Q4 Jan–Mar"]], on: true },
  { id: "advtax", name: "Advance tax instalment", cat: "Income tax", kind: "dates", dates: [["06-15", "15% of year's tax"], ["09-15", "45%"], ["12-15", "75%"], ["03-15", "100%"]], on: true },
  { id: "taxaudit", name: "Tax audit report (3CA/3CD)", cat: "Income tax", kind: "dates", dates: [["09-30", "previous FY"]], on: true },
  { id: "itr", name: "Company income tax return (ITR-6)", cat: "Income tax", kind: "dates", dates: [["10-31", "previous FY"]], on: true },
  { id: "pf", name: "PF (EPF) contribution + ECR", cat: "Payroll", kind: "monthly", day: 15, on: true },
  { id: "esi", name: "ESI contribution", cat: "Payroll", kind: "monthly", day: 15, on: true },
  { id: "pt", name: "Professional Tax (Karnataka)", cat: "Payroll", kind: "monthly", day: 20, on: true },
  { id: "agm", name: "Annual General Meeting", cat: "Company law (ROC)", kind: "dates", dates: [["09-30", "previous FY"]], on: true },
  { id: "dir3", name: "DIR-3 KYC (directors)", cat: "Company law (ROC)", kind: "dates", dates: [["09-30", "every director"]], on: true },
  { id: "aoc4", name: "AOC-4 (financial statements)", cat: "Company law (ROC)", kind: "dates", dates: [["10-30", "30 days after AGM"]], on: true },
  { id: "mgt7", name: "MGT-7A annual return", cat: "Company law (ROC)", kind: "dates", dates: [["11-29", "60 days after AGM"]], on: true },
  { id: "msme1", name: "MSME-1 (dues to MSMEs over 45 days)", cat: "Company law (ROC)", kind: "dates", dates: [["04-30", "Oct–Mar"], ["10-31", "Apr–Sep"]], on: true },
];
const LICENCE_SUGGESTIONS = ["Factory licence", "Pollution board consent (KSPCB CFO)", "Fire NOC", "BBMP trade licence", "Legal Metrology registration (packaged goods)",
  "GST registration", "Import Export Code (IEC)", "Udyam registration", "GS1 barcode membership", "Factory fire & stock insurance", "Vehicle insurance", "Keyman insurance", "Boiler / machinery certificate", "Weighing scale stamping"];

function occurrences(items, from, to) {
  const out = [];
  (items || []).filter((it) => it.on !== false).forEach((it) => {
    if (it.kind === "monthly") {
      const f = new Date(from + "T00:00:00Z"); f.setUTCDate(1); f.setUTCMonth(f.getUTCMonth() - 1);
      for (let k = 0; k < 16; k++) {
        const per = new Date(Date.UTC(f.getUTCFullYear(), f.getUTCMonth() + k, 1));
        const py = per.getUTCFullYear(), pm = per.getUTCMonth();
        let due;
        if (pm === 2 && it.marchDue) due = py + "-" + it.marchDue;
        else { const dm = new Date(Date.UTC(py, pm + 1, 1)); due = dm.getUTCFullYear() + "-" + pad(dm.getUTCMonth() + 1) + "-" + pad(it.day); }
        if (due < from || due > to) continue;
        out.push({ key: it.id + "|" + due, id: it.id, name: it.name, cat: it.cat, due, period: MONTHS[pm] + " " + py, month: py + "-" + pad(pm + 1) });
      }
    } else {
      const y0 = +from.slice(0, 4) - 1, y1 = +to.slice(0, 4) + 1;
      for (let y = y0; y <= y1; y++) (it.dates || []).forEach(([md, label]) => {
        const due = y + "-" + md; if (due < from || due > to) return;
        out.push({ key: it.id + "|" + due, id: it.id, name: it.name, cat: it.cat, due, period: label });
      });
    }
  });
  return out.sort((a, b) => (a.due < b.due ? -1 : 1));
}

// Months whose GSTR-1 is marked filed — edits there are escalated by the audit
function filedMonths(state) {
  const set = new Set();
  Object.keys((state && state.done) || {}).forEach((k) => { const [id, due] = k.split("|"); if (id === "gstr1" && due) { const d = new Date(due + "T00:00:00Z"); d.setUTCMonth(d.getUTCMonth() - 1); set.add(d.getUTCFullYear() + "-" + pad(d.getUTCMonth() + 1)); } });
  return set;
}

// Which reminders are due today (statutory items): 7 and 2 days before, on the day, then every 3 days overdue
function dueReminders(state, today) {
  const st = state || {}, done = st.done || {}, sent = st.sent || {};
  // only remind about deadlines from the day tracking started (earlier ones were handled before this existed)
  const occ = occurrences(st.items || DEFAULT_ITEMS, st.since || today, isoAdd(today, 8));
  const out = [];
  occ.forEach((o) => {
    if (done[o.key]) return;
    const left = days(today, o.due);
    const hit = left === 7 || left === 2 || left === 0 || (left < 0 && (-left) % 3 === 0);
    if (hit && sent[o.key] !== today) out.push(Object.assign({ left }, o));
  });
  return out;
}

// Licences / insurance / asset renewals: 60, 30, 7, 1 days before; weekly once expired
function expiryReminders(list, today, what) {
  const out = [];
  (list || []).forEach((x) => { [["expiry", ""], ["insuranceExpiry", " insurance"], ["amcExpiry", " AMC"]].forEach(([f, suffix]) => {
    if (!x[f]) return; const left = days(today, x[f]);
    if ([60, 30, 7, 1].includes(left) || (left <= 0 && (-left) % 7 === 0)) out.push({ what, name: (x.name || "?") + suffix, date: x[f], left, number: x.number || "" });
  }); });
  return out;
}

// MSME suppliers: bills unpaid beyond 45 days (section 43B(h))
function msmeDues(payRows, msmeNames, today) {
  const names = (msmeNames || []).map((n) => String(n).toLowerCase().trim()).filter(Boolean);
  if (!names.length) return [];
  return (payRows || []).filter((r) => r.party && names.some((n) => r.party.toLowerCase().includes(n)) && /^\d{4}-\d{2}-\d{2}$/.test(r.date || ""))
    .map((r) => ({ party: r.party, ref: r.ref, date: r.date, amt: Math.abs(r.amt || 0), age: days(r.date, today), payBy: isoAdd(r.date, 45) }))
    .sort((a, b) => b.age - a.age);
}

// Bank reconciliation between a bank statement account and a Tally bank ledger
function reconcile(bankTxns, vouchers, ledger) {
  const L = String(ledger || "").toLowerCase();
  const tl = [];
  (vouchers || []).forEach((v) => { if (v.c) return; (v.le || []).forEach((l) => { if (l.l.toLowerCase() === L && l.a) tl.push({ d: v.d, amt: Math.abs(l.a), dir: l.a < 0 ? "in" : "out", t: v.t, n: v.n, p: v.p, ch: v.ch || "", used: false }); }); });
  const bk = (bankTxns || []).map((x) => ({ d: x.d, amt: x.cr || x.dr, dir: x.cr ? "in" : "out", desc: x.desc, ref: x.ref, used: false }));
  if (!tl.length || !bk.length) return { tallyCount: tl.length, bankCount: bk.length, notInTally: [], notInBank: [], matched: 0 };
  tl.sort((a, b) => (a.d < b.d ? -1 : 1)); bk.sort((a, b) => (a.d < b.d ? -1 : 1));
  let matched = 0;
  tl.forEach((t) => {
    const cand = bk.find((b) => !b.used && b.dir === t.dir && Math.abs(b.amt - t.amt) < 0.6 && days(t.d, b.d) >= -3 && days(t.d, b.d) <= 10);
    if (cand) { cand.used = true; t.used = true; matched++; }
  });
  const from = tl[0].d > bk[0].d ? tl[0].d : bk[0].d;
  const toT = tl[tl.length - 1].d, toB = bk[bk.length - 1].d;
  return {
    tallyCount: tl.length, bankCount: bk.length, matched, from, toTally: toT, toBank: toB,
    // in the bank but not in Tally: up to the last date Tally data covers
    notInTally: bk.filter((b) => !b.used && b.d >= from && b.d <= toT).map((b) => ({ d: b.d, amt: b.amt, dir: b.dir, desc: b.desc, ref: b.ref })),
    // in Tally but not (yet) in the bank: give cheques 7 days to clear
    notInBank: tl.filter((t) => !t.used && t.d >= from && t.d <= isoAdd(toB, -7)).map((t) => ({ d: t.d, amt: t.amt, dir: t.dir, t: t.t, n: t.n, p: t.p, ch: t.ch })),
  };
}

// Income-tax WDV (half rate if used < 180 days in the year of purchase) and Companies Act straight line
const IT_RATES = { "Plant & machinery": 15, "Building (factory)": 10, "Furniture & fittings": 10, "Computers & software": 40, "Motor car": 15, "Motor vehicle (commercial)": 30, "Electrical installations": 10, "Intangibles": 25 };
const CO_LIFE = { "Plant & machinery": 15, "Building (factory)": 30, "Furniture & fittings": 10, "Computers & software": 3, "Motor car": 8, "Motor vehicle (commercial)": 6, "Electrical installations": 10, "Intangibles": 10 };

module.exports = { DEFAULT_ITEMS, LICENCE_SUGGESTIONS, IT_RATES, CO_LIFE, occurrences, filedMonths, dueReminders, expiryReminders, msmeDues, reconcile, days, isoAdd };
