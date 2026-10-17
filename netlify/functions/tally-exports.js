// Export register (exports under LUT). Tracks each export invoice from Tally
// through shipping bill, money received (matched from bank statement credits),
// and eBRC — with reminders before the RBI realisation deadline. Under LUT, if
// export proceeds aren't realised in time, IGST becomes payable with interest
// (GST Rule 96A), so the deadline matters twice. Periods are settings; the
// CA / bank should confirm the current rules.
const days = (a, b) => Math.round((new Date(b + "T00:00:00Z") - new Date(a + "T00:00:00Z")) / 864e5);
const addMonths = (d, n) => { const x = new Date(d + "T00:00:00Z"); x.setUTCMonth(x.getUTCMonth() + n); return x.toISOString().slice(0, 10); };
const r0 = (n) => Math.round(Number(n) || 0);
const DEFAULTS = { months: 9, buyers: [], lutArn: "", lutValidTo: "" };
const FX = /inward|remit|swift|forex|\bfx\b|firc|\birm\b|\busd\b|\baed\b|\beur\b|\bgbp\b|ttr\b|foreign|export proceeds|exp\.? ?proceeds/i;
const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();

function settingsOf(reg) { return Object.assign({}, DEFAULTS, (reg && reg.settings) || {}); }

// derived status of one invoice
function status(x, today, st) {
  const base = x.sbDate || x.invDate;
  const deadline = base ? addMonths(base, Number(st.months) || 9) : "";
  const realised = (x.realised || []).reduce((a, r) => a + (Number(r.amt) || 0), 0);
  const pct = x.inrValue ? Math.min(100, realised / x.inrValue * 100) : 0;
  const full = x.fullyRealised || pct >= 97;
  return { deadline, left: deadline ? days(today, deadline) : null, age: base ? days(base, today) : null, realisedINR: r0(realised), pct: Math.round(pct),
    full, ebrcDue: full && !x.ebrcNo, sbMissing: !x.sbNo && x.invDate && days(x.invDate, today) > 7 };
}

// export sales in the Day Book not yet in the register
function tallyCandidates(vouchers, reg) {
  const st = settingsOf(reg), have = new Set(((reg && reg.list) || []).map((x) => norm(x.invNo)));
  const buyers = (st.buyers || []).map(norm).filter(Boolean);
  return (vouchers || []).filter((v) => !v.c && /sales/i.test(v.t || "") && !/order|return|credit/i.test(v.t || "") &&
      (/export/i.test(v.t || "") || buyers.some((b) => norm(v.p).includes(b))) && !have.has(norm(v.n)))
    .map((v) => ({ invNo: v.n, invDate: v.d, buyer: v.p, inrValue: r0(v.a), type: v.t })).slice(-100).reverse();
}

// foreign-remittance credits in bank statements → suggested matches to open invoices
function bankSuggestions(bank, reg) {
  const list = ((reg && reg.list) || []);
  const used = new Set(); list.forEach((x) => (x.realised || []).forEach((r) => { if (r.key) used.add(r.key); }));
  const out = [];
  Object.keys((bank && bank.accounts) || {}).forEach((acc) => (bank.accounts[acc].txns || []).forEach((t) => {
    if (!t.cr || !FX.test((t.desc || "") + " " + (t.ref || ""))) return;
    const key = acc + "|" + t.d + "|" + t.cr + "|" + norm(t.desc).slice(0, 30);
    if (used.has(key)) return;
    const open = list.filter((x) => !x.fullyRealised && x.invDate && x.invDate <= t.d);
    let best = null, why = "";
    open.forEach((x) => {
      const remaining = (x.inrValue || 0) - (x.realised || []).reduce((a, r) => a + (Number(r.amt) || 0), 0);
      const nameHit = x.buyer && norm(t.desc).includes(norm(x.buyer).split(" ")[0]);
      const amtHit = remaining > 0 && Math.abs(t.cr - remaining) / remaining <= 0.08;     // exchange-rate difference allowed
      const score = (nameHit ? 2 : 0) + (amtHit ? 2 : 0);
      if (score && (!best || score > best.score || (score === best.score && x.invDate < best.x.invDate))) { best = { x, score }; why = (nameHit ? "buyer name in narration" : "") + (nameHit && amtHit ? " + " : "") + (amtHit ? "amount matches what's due" : ""); }
    });
    out.push({ key, account: acc, d: t.d, amt: t.cr, desc: t.desc, ref: t.ref, suggest: best ? { id: best.x.id, invNo: best.x.invNo, buyer: best.x.buyer, why } : null });
  }));
  return out.sort((a, b) => (a.d < b.d ? 1 : -1)).slice(0, 60);
}

// reminders: 6 months unrealised, 8 months, 15 days before the deadline, then weekly once overdue;
// shipping bill details missing after a week; eBRC not recorded 30 days after full realisation; LUT expiry
function reminders(reg, today) {
  const st = settingsOf(reg), out = [];
  ((reg && reg.list) || []).forEach((x) => {
    const s = status(x, today, st), lab = (x.invNo || "?") + " · " + (x.buyer || "") + " · ₹" + r0(x.inrValue).toLocaleString("en-IN");
    if (!s.full && s.deadline) {
      const m6 = addMonths(x.sbDate || x.invDate, 6), m8 = addMonths(x.sbDate || x.invDate, 8);
      if (today === m6) out.push({ key: x.id + "|6m", sev: "medium", text: "6 months since export, money not fully received (" + s.pct + "%): " + lab + " — RBI deadline " + s.deadline });
      if (today === m8) out.push({ key: x.id + "|8m", sev: "high", text: "8 months since export, " + (100 - s.pct) + "% still to come: " + lab + " — deadline " + s.deadline + ". Talk to the buyer and your bank now." });
      if (s.left === 15) out.push({ key: x.id + "|15d", sev: "high", text: "15 days to the RBI realisation deadline: " + lab + " — if not realised, ask the bank about an extension and the CA about IGST under LUT rules." });
      if (s.left < 0 && (-s.left) % 7 === 0) out.push({ key: x.id + "|od" + s.left, sev: "high", text: "Realisation OVERDUE by " + -s.left + " days: " + lab + " — IGST with interest may become payable under LUT; speak to the CA and the bank." });
    }
    if (s.sbMissing && days(x.invDate, today) % 7 === 1) out.push({ key: x.id + "|sb" + today, sev: "medium", text: "Shipping bill details not entered for " + lab + " (invoice " + x.invDate + ")" });
    if (s.ebrcDue) { const lastR = (x.realised || []).map((r) => r.d).sort().pop(); if (lastR && days(lastR, today) >= 30 && days(lastR, today) % 7 === 2) out.push({ key: x.id + "|ebrc" + today, sev: "medium", text: "Payment received but eBRC not recorded: " + lab + " — generate the eBRC on the DGFT portal / ask the bank" }); }
  });
  if (st.lutValidTo) { const l = days(today, st.lutValidTo); if ([30, 15, 7, 1].includes(l) || (l < 0 && (-l) % 7 === 0)) out.push({ key: "lut|" + today, sev: "high", text: "LUT (export without IGST) " + (l < 0 ? "EXPIRED " + -l + " days ago" : "expires in " + l + " days") + " — file the new LUT (RFD-11) on the GST portal" }); }
  return out;
}

function summary(reg, today) {
  const st = settingsOf(reg), list = (reg && reg.list) || [];
  const rows = list.map((x) => Object.assign({ x }, status(x, today, st)));
  const open = rows.filter((r) => !r.full);
  const unreal = open.reduce((a, r) => a + Math.max(0, (r.x.inrValue || 0) - r.realisedINR), 0);
  const near = open.filter((r) => r.left != null).sort((a, b) => a.left - b.left)[0];
  return { invoices: list.length, open: open.length, unrealisedINR: r0(unreal), overdue: open.filter((r) => r.left != null && r.left < 0).length,
    within60: open.filter((r) => r.left != null && r.left >= 0 && r.left <= 60).length, ebrcPending: rows.filter((r) => r.ebrcDue).length,
    nearest: near ? { invNo: near.x.invNo, buyer: near.x.buyer, deadline: near.deadline, left: near.left } : null,
    lut: st.lutValidTo ? { validTo: st.lutValidTo, left: days(today, st.lutValidTo) } : null };
}
module.exports = { status, tallyCandidates, bankSuggestions, reminders, summary, settingsOf, DEFAULTS };
