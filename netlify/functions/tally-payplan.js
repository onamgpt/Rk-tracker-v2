// Supplier payment planner for cash-tight weeks.
// Order of priority inside the weekly budget:
//   1. must-pay: statutory dues entered for the week, MSME bills reaching 45 days (s.43B(h))
//   2. critical suppliers (raw bathi, perfumery compounds, packaging) — oldest bills first
//   3. a fair "goodwill" part-payment to anyone left unpaid too long, so nobody is ignored
//   4. important, then flexible suppliers — oldest first
// No supplier takes more than `capPct` of the budget (unless it's a must-pay), so one
// supplier can't swallow the week. Suppliers chasing by email move up within their tier.
const r0 = (n) => Math.round(Number(n) || 0);
const days = (a, b) => Math.round((new Date(b + "T00:00:00Z") - new Date(a + "T00:00:00Z")) / 864e5);
const PAYMENT = (t) => /payment|pymt|\bpmt\b/i.test(t || "");
const PURCH = (t) => /purchase/i.test(t || "") && !/order|return|debit/i.test(t || "");
const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();

const KEYWORDS = [
  ["critical", /bath?i|batti|stick|bamboo|perfum|compound|fragranc|aroma|essential oil|\boil\b|chemic|chemixil|resin|charcoal|jigat|powder|box|carton|pack|print|wrapper|label|pouch|film|corrugat/i],
  ["important", /transport|freight|logistic|courier|cargo|power|electric|bescom|rent|labour|contract/i],
];
function autoTier(name) { for (const [t, re] of KEYWORDS) if (re.test(name || "")) return t; return "flexible"; }

function suppliers(payRows, settings, mailIntel) {
  const tiers = (settings && settings.tiers) || {}, msme = ((settings && settings.msme) || []).map(norm);
  const chase = {};
  ((mailIntel && mailIntel.items) || []).filter((x) => x.cat === "supplier_chasing_payment" && Date.now() - new Date(x.at).getTime() < 30 * 864e5)
    .forEach((x) => { const k = norm(x.party || x.from); chase[k] = (chase[k] || 0) + 1; });
  const by = {};
  (payRows || []).forEach((r) => {
    if (!r.party || !(Math.abs(r.amt || 0) > 0)) return;
    const s = by[r.party] || (by[r.party] = { party: r.party, bills: [], due: 0 });
    s.bills.push({ ref: r.ref || "", date: r.date || "", amt: Math.abs(r.amt || 0), over: r.over || (r.date ? days(r.date, today()) : 0) }); s.due += Math.abs(r.amt || 0);
  });
  return Object.values(by).map((s) => {
    s.bills.sort((a, b) => (a.date < b.date ? -1 : 1));
    s.tier = tiers[s.party] || autoTier(s.party);
    s.msme = msme.some((m) => m && norm(s.party).includes(m));
    s.chasing = Object.keys(chase).filter((k) => k && (norm(s.party).includes(k) || k.includes(norm(s.party).split(" ")[0]))).reduce((a, k) => a + chase[k], 0);
    s.oldest = s.bills.length ? s.bills[0].over : 0;
    return s;
  });
}
const today = () => new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10);

// payments and purchases per supplier over the last N days, from the Day Book
function history(vouchers, n) {
  const t = today(), h = {};
  (vouchers || []).forEach((v) => {
    if (v.c || !v.p || days(v.d, t) > n) return;
    const x = h[v.p] || (h[v.p] = { paid: 0, bought: 0, lastPaid: "" });
    if (PAYMENT(v.t)) { x.paid += v.a || 0; if (v.d > x.lastPaid) x.lastPaid = v.d; }
    else if (PURCH(v.t)) x.bought += v.a || 0;
  });
  return h;
}

function buildPlan(sup, hist, budget, opts) {
  opts = opts || {};
  const cap = (opts.capPct || 40) / 100 * budget, goodwillPct = (opts.goodwillPct || 5) / 100;
  const lines = [], left = { v: budget }, paidTo = {};
  const take = (s, bills, amount, reason, force) => {
    let room = force ? amount : Math.min(amount, cap - (paidTo[s.party] || 0));
    room = Math.min(room, left.v); if (room < 1000) return 0;
    left.v -= room; paidTo[s.party] = (paidTo[s.party] || 0) + room;
    const ex = lines.find((l) => l.party === s.party);
    if (ex) { ex.amount += room; if (ex.reasons.indexOf(reason) < 0) ex.reasons.push(reason); ex.bills = Array.from(new Set(ex.bills.concat(bills))); }
    else lines.push({ party: s.party, tier: s.tier, msme: s.msme, chasing: s.chasing, amount: room, bills, reasons: [reason], due: r0(s.due), oldest: s.oldest });
    return room;
  };
  // remaining unpaid per bill as we allocate
  const rem = new Map(); sup.forEach((s) => s.bills.forEach((b, i) => rem.set(s.party + "|" + i, b.amt)));
  const payBills = (s, filter, reason, force, limit) => {
    let spent = 0;
    s.bills.forEach((b, i) => {
      if (!filter(b)) return; const k = s.party + "|" + i, r = rem.get(k); if (!(r > 0)) return;
      const want = Math.min(r, limit != null ? limit - spent : r); if (want <= 0) return;
      const got = take(s, [b.ref || b.date], want, reason, force); rem.set(k, r - got); spent += got;
    });
    return spent;
  };
  // 1. MSME bills at 38+ days (pay before day 45)
  sup.filter((s) => s.msme).forEach((s) => payBills(s, (b) => b.over >= 38, "MSME bill near/over 45 days (s.43B(h))", true));
  const order = (a, b) => (b.chasing - a.chasing) || (b.oldest - a.oldest);
  // 2. critical suppliers, oldest first
  sup.filter((s) => s.tier === "critical").sort(order).forEach((s) => payBills(s, (b) => b.over >= 30, "critical supplier — oldest bills first" + (s.chasing ? " (chasing by email)" : "")));
  // 3. goodwill: unpaid for 45+ days with bills over 60 days
  sup.filter((s) => s.oldest > 60).sort(order).forEach((s) => {
    const last = (hist[s.party] || {}).lastPaid;
    if (last && days(last, today()) < 45) return;
    payBills(s, (b) => b.over > 60, "goodwill part-payment — nothing paid " + (last ? "since " + last : "in 90 days"), false, Math.max(10000, budget * goodwillPct));
  });
  // 4. important then flexible
  ["important", "flexible", "critical"].forEach((t) => sup.filter((s) => s.tier === t).sort(order).forEach((s) => payBills(s, (b) => b.over >= 45, t + " supplier — overdue bills")));
  lines.forEach((l) => { l.amount = r0(l.amount); });
  return { budget: r0(budget), allocated: r0(budget - left.v), unallocated: r0(left.v), lines: lines.sort((a, b) => b.amount - a.amount) };
}

// who has been paid ahead, and who is being starved
function imbalance(sup, hist) {
  const rows = sup.map((s) => { const h = hist[s.party] || { paid: 0, bought: 0, lastPaid: "" };
    return { party: s.party, tier: s.tier, due: r0(s.due), oldest: s.oldest, paid90: r0(h.paid), bought90: r0(h.bought), lastPaid: h.lastPaid, chasing: s.chasing }; });
  const starved = rows.filter((r) => r.oldest > 90 && (!r.lastPaid || days(r.lastPaid, today()) > 60)).sort((a, b) => b.due - a.due);
  const totalPaid = rows.reduce((a, r) => a + r.paid90, 0);
  const ahead = rows.filter((r) => r.paid90 > 0 && r.paid90 > r.bought90 * 1.2 && r.oldest < 45 && totalPaid > 0 && r.paid90 / totalPaid > 0.15).sort((a, b) => b.paid90 - a.paid90);
  return { starved: starved.slice(0, 15), ahead: ahead.slice(0, 10), rows: rows.sort((a, b) => b.due - a.due) };
}

// a starting point for the weekly budget: bank balance + part of what customers owe this week − statutory dues
function suggestBudget(bank, recvRows, statutory, settings) {
  const bal = Object.values((bank && bank.accounts) || {}).reduce((a, acc) => { const t = acc.txns || []; const b = t.length ? t[t.length - 1].bal : 0; return a + (b > 0 ? b : 0); }, 0);
  const t = today(), in7 = (recvRows || []).filter((r) => r.due && days(t, r.due) >= 0 && days(t, r.due) <= 7).reduce((a, r) => a + Math.abs(r.amt || 0), 0);
  const stat = (statutory || []).reduce((a, s) => a + (Number(s.amount) || 0), 0);
  const buffer = Number(settings && settings.buffer) || 200000;
  return { bankBalance: r0(bal), customerDue7d: r0(in7), expectIn: r0(in7 * 0.5), statutory: r0(stat), buffer, suggested: Math.max(0, r0(bal + in7 * 0.5 - stat - buffer)) };
}
module.exports = { suppliers, history, buildPlan, imbalance, suggestBudget, autoTier };
