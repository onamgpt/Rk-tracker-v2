// Audit checks on every Day Book upload — the things an auditor asks about.
// Compares the new export with what was received before, so entries that are
// cancelled, deleted, changed or back-dated later are caught, and checks the
// numbering and amounts. New findings are emailed to Ravi once.
const FY_START = (d) => { const y = +d.slice(0, 4), m = +d.slice(5, 7); return (m >= 4 ? y : y - 1) + "-04-01"; };
const isSales = (t) => /sales/i.test(t || "") && !/order|return|credit/i.test(t || "");
const isPurchaseLike = (t) => /purchase|payment|journal/i.test(t || "") && !/order/i.test(t || "");
const inr = (n) => "₹" + Math.round(Number(n) || 0).toLocaleString("en-IN");
const tn = (v) => (v.t || "") + "#" + (v.n || "");

// Split "OA/25-26/0123" into a series prefix and a running number
function series(n) {
  const m = String(n || "").match(/^(.*?)(\d+)(\D*)$/);
  return m ? { pre: m[1] + "…" + m[3], num: parseInt(m[2], 10), width: m[2].length, raw: m } : null;
}

// prev: vouchers held before this upload; incoming: this export
function check(prev, incoming, prevUpTo, knownGone) {
  knownGone = knownGone || new Set();
  const flags = [];
  const add = (kind, sev, v, note) => flags.push({ kind, sev, d: v.d, t: v.t, n: v.n, p: v.p, a: Math.round(v.a || 0),
    note, key: kind + "|" + tn(v) + "|" + v.d + "|" + note.slice(0, 60) });
  if (!incoming.length) return flags;
  const lo = incoming.reduce((m, v) => (v.d < m ? v.d : m), incoming[0].d), hi = incoming.reduce((m, v) => (v.d > m ? v.d : m), incoming[0].d);
  const prevIn = prev.filter((v) => v.d >= lo && v.d <= hi);
  const byTN = new Map(incoming.map((v) => [tn(v), v]));
  const deletedNums = new Set();
  const prevTN = new Map(prev.map((v) => [tn(v), v]));

  // 1. cancelled and optional vouchers in this export
  incoming.forEach((v) => {
    if (v.c) add("Cancelled", isSales(v.t) ? "high" : "medium", v, (isSales(v.t) ? "Sales invoice" : v.t || "Voucher") + " marked cancelled" + (v.r ? " — narration: " + v.r : "") + (v.irn ? " · it had an e-invoice (IRN) — check it was cancelled on the IRP too" : "") + (v.ew ? " · e-way bill " + v.ew + " — check it was cancelled on the portal" : ""));
    if (v.o) add("Optional voucher", "low", v, "Optional (memo) voucher — not posted to the books");
  });
  // 2. deleted or changed since an earlier export of the same dates
  prevIn.forEach((v) => {
    if (!v.n) return;
    const now = byTN.get(tn(v));
    if (!now) { deletedNums.add(tn(v)); add("Deleted / renumbered", isSales(v.t) ? "high" : "medium", v, "Was in an earlier export (" + inr(v.a) + (v.p ? ", " + v.p : "") + ") but is missing now"); }
    else if (!now.c) {
      const ch = [];
      if (Math.round(now.a || 0) !== Math.round(v.a || 0)) ch.push("amount " + inr(v.a) + " → " + inr(now.a));
      if ((now.p || "") !== (v.p || "") && v.p) ch.push("party " + v.p + " → " + (now.p || "—"));
      if (now.d !== v.d) ch.push("date " + v.d + " → " + now.d);
      if (ch.length) add("Changed after export", isSales(v.t) ? "high" : "medium", now, "Altered since the earlier export: " + ch.join("; "));
    }
  });
  // 3. back-dated: new vouchers dated more than 3 days before what we already had
  if (prevUpTo) {
    const limit = new Date(new Date(prevUpTo + "T00:00:00Z").getTime() - 3 * 864e5).toISOString().slice(0, 10);
    incoming.forEach((v) => { if (v.d < limit && v.n && !prevTN.has(tn(v)) && !v.c) add("Back-dated entry", "medium", v, "New entry dated " + v.d + ", but data up to " + prevUpTo + " had already been received"); });
  }
  // 4. sales invoices: duplicate numbers and gaps in numbering (whole financial year),
  //    on the books as they stand after this export (old versions replaced)
  const all = new Map(); prev.filter((v) => v.d < lo || v.d > hi).concat(incoming).forEach((v, i) => all.set(i, v));
  const fy = FY_START(hi);
  const sales = Array.from(all.values()).filter((v) => isSales(v.t) && v.d >= fy && v.n);
  const seen = new Map();
  sales.forEach((v) => { const k = tn(v); if (seen.has(k) && (seen.get(k).d !== v.d || Math.round(seen.get(k).a) !== Math.round(v.a))) add("Duplicate invoice number", "high", v, "Number " + v.n + " used twice (" + seen.get(k).d + " " + inr(seen.get(k).a) + " and " + v.d + " " + inr(v.a) + ")"); seen.set(k, v); });
  const groups = {};
  sales.forEach((v) => { const s = series(v.n); if (!s) return; const g = groups[v.t + "|" + s.pre] || (groups[v.t + "|" + s.pre] = { t: v.t, s, nums: new Map() }); g.nums.set(s.num, v); });
  Object.values(groups).forEach((g) => {
    const nums = Array.from(g.nums.keys()).sort((a, b) => a - b);
    if (nums.length < 3) return;
    for (let i = 1; i < nums.length; i++) {
      const gap = nums[i] - nums[i - 1] - 1;
      if (gap > 0 && gap <= 50) {
        const after = g.nums.get(nums[i - 1]);
        const missing = []; for (let k = nums[i - 1] + 1; k < nums[i] && missing.length < 10; k++) { const nm = g.s.raw[1] + String(k).padStart(g.s.width, "0") + g.s.raw[3]; if (!deletedNums.has(g.t + "#" + nm) && !knownGone.has(g.t + "#" + nm)) missing.push(nm); }
        if (!missing.length) continue;
        add("Missing invoice number", "high", { d: after.d, t: g.t, n: missing.join(", "), p: "", a: 0 },
          gap + " number(s) skipped in the " + g.t + " series after " + after.n + " (" + after.d + ") — deleted or cancelled invoice?");
      }
    }
  });
  // 5. possible double entries: same party, same amount, within 3 days, different numbers
  const recent = Array.from(all.values()).filter((v) => v.d >= lo && isPurchaseLike(v.t) && v.p && (v.a || 0) >= 1000 && !v.c);
  const buckets = {};
  recent.forEach((v) => { const k = v.t + "|" + v.p.toLowerCase() + "|" + Math.round(v.a); (buckets[k] = buckets[k] || []).push(v); });
  Object.values(buckets).forEach((b) => { b.sort((x, y) => (x.d < y.d ? -1 : 1)); for (let i = 1; i < b.length; i++) {
    const days = (new Date(b[i].d) - new Date(b[i - 1].d)) / 864e5;
    if (days <= 3 && b[i].n !== b[i - 1].n) add("Possible double entry", "medium", b[i], "Same party and amount as " + b[i - 1].t + " " + (b[i - 1].n || "") + " on " + b[i - 1].d);
  } });
  // 6. incomplete sales / unexplained journals
  incoming.forEach((v) => {
    if (isSales(v.t) && !v.c && !(v.a > 0)) add("Zero-value invoice", "medium", v, "Sales voucher with no amount");
    if (isSales(v.t) && !v.c && !v.p) add("No party", "low", v, "Sales voucher without a party name");
    if (/journal/i.test(v.t || "") && v.r === "" && v._xml) add("Journal without narration", "low", v, "Journal entry has no narration — auditors usually ask why");
  });
  // 7. e-way bills (only when the export carries e-way bill details)
  const hasEW = incoming.some((v) => v.ew !== undefined);
  if (hasEW) incoming.forEach((v) => { if (isSales(v.t) && !v.c && (v.a || 0) >= 50000 && !v.ew && (v.i || []).length) add("E-way bill missing", "medium", v, "Goods invoice of " + inr(v.a) + " with no e-way bill number in Tally (₹50,000 rule — check if exempt)"); });
  return flags;
}

function emailBody(fresh, upTo) {
  const order = { high: 0, medium: 1, low: 2 };
  fresh.sort((a, b) => order[a.sev] - order[b.sev] || (a.d < b.d ? -1 : 1));
  const icon = { high: "🔴", medium: "🟠", low: "⚪" };
  return "<div style='font-family:Arial,sans-serif;font-size:14px;line-height:1.55'><p>Tally audit check on the latest Day Book" + (upTo ? " (data up to " + upTo + ")" : "") + " found <b>" + fresh.length + " new item(s)</b> an auditor may ask about:</p><table cellpadding='6' style='border-collapse:collapse;font-size:13px'>" +
    "<tr style='background:#eef2f6'><th align='left'></th><th align='left'>Check</th><th align='left'>Date</th><th align='left'>Voucher</th><th align='left'>Party</th><th align='right'>Amount</th><th align='left'>Details</th></tr>" +
    fresh.map((f) => "<tr style='border-top:1px solid #dde3ea'><td>" + icon[f.sev] + "</td><td><b>" + f.kind + "</b></td><td>" + f.d + "</td><td>" + (f.t || "") + " " + (f.n || "") + "</td><td>" + (f.p || "") + "</td><td align='right'>" + (f.a ? inr(f.a) : "") + "</td><td>" + f.note + "</td></tr>").join("") +
    "</table><p>Open the full list: <a href='https://rk-tracker-v2.netlify.app/tally/'>Tally → 🧾 Audit</a></p></div>";
}
module.exports = { check, emailBody };
