// 1st of each month, 08:30 IST: last month's purchases, to Ravi only.
const L = require("./purchase-lib.js");
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const rs = (n) => "₹" + Math.round(Number(n) || 0).toLocaleString("en-IN");
const TH = "style='text-align:left;padding:6px 7px;border-bottom:2px solid #ccc;font-size:13px'", TD = "style='padding:6px 7px;border-bottom:1px solid #e5e5e5;font-size:13px'";
const tbl = (head, rows) => "<table style='border-collapse:collapse;width:100%'><tr>" + head.map((h) => "<th " + TH + ">" + h + "</th>").join("") + "</tr>" + rows.map((r) => "<tr>" + r.map((c) => "<td " + TD + ">" + c + "</td>").join("") + "</tr>").join("") + "</table>";

async function run(opt) {
  opt = opt || {};
  const D = await L.load();
  const I = L.purchaseIntel(D, ((await L.kvGet("tally_pay")) || {}).rows || []);
  const today = L.todayIST();
  const firstThis = today.slice(0, 8) + "01", lastMonth = L.addDays(firstThis, -1).slice(0, 7), prevMonth = L.addDays(lastMonth + "-01", -1).slice(0, 7);
  const amt = (m) => (I.months.find((x) => x.m === m) || {}).amt || 0;
  const cur = amt(lastMonth), prev = amt(prevMonth);
  const inMonth = (I.bills || []).filter((b) => b.d.slice(0, 7) === lastMonth);
  const cats = {}, sups = {};
  inMonth.forEach((b) => b.items.forEach((x) => { const c = L.CATS[(D.items[x.i] && D.items[x.i].cat) || L.classify(x.i)] || "Other"; cats[c] = (cats[c] || 0) + x.a; sups[b.p] = (sups[b.p] || 0) + x.a; }));
  // price change: last month's average rate vs the month before, per material
  const moves = (I.items || []).map((x) => {
    const a = x.history.filter((h) => h.d.slice(0, 7) === lastMonth), b = x.history.filter((h) => h.d.slice(0, 7) < lastMonth).slice(-3);
    if (!a.length || !b.length) return null;
    const ra = a.reduce((s, h) => s + h.rate, 0) / a.length, rb = b.reduce((s, h) => s + h.rate, 0) / b.length;
    return { item: x.item, unit: x.unit, now: ra, before: rb, pct: Math.round((ra / rb - 1) * 1000) / 10 };
  }).filter((x) => x && Math.abs(x.pct) >= 3).sort((a, b) => b.pct - a.pct);
  let h = "<div style='font-family:Arial,sans-serif;font-size:15px;color:#16181c;max-width:760px'><p><b>Purchases — " + esc(lastMonth) + "</b></p>";
  if (!I.hasData) h += "<p>No purchase bills with item lines have arrived from Tally yet. They come from the Day Book XML Maadhu sends.</p>";
  else {
    h += "<p>Total: <b>" + rs(cur) + "</b>" + (prev ? " (" + (cur >= prev ? "+" : "") + Math.round((cur / prev - 1) * 100) + "% vs " + esc(prevMonth) + ")" : "") + " across " + inMonth.length + " bills.</p>";
    const C = Object.keys(cats).sort((a, b) => cats[b] - cats[a]);
    if (C.length) h += "<h3>By category</h3>" + tbl(["Category", "Spend"], C.map((k) => [esc(k), rs(cats[k])]));
    const S = Object.keys(sups).sort((a, b) => sups[b] - sups[a]).slice(0, 10);
    if (S.length) h += "<h3>Top suppliers</h3>" + tbl(["Supplier", "Spend"], S.map((k) => [esc(k), rs(sups[k])]));
    if (moves.length) h += "<h3>Price changes (vs earlier buys)</h3>" + tbl(["Material", "Last month", "Before", "Change"], moves.slice(0, 20).map((m) => [esc(m.item), "₹" + m.now.toFixed(2) + "/" + esc(m.unit), "₹" + m.before.toFixed(2), "<b style='color:" + (m.pct > 0 ? "#b42318" : "#1F7A4D") + "'>" + (m.pct > 0 ? "+" : "") + m.pct + "%</b>"]));
  }
  if (I.payables.length) h += "<h3>Payables</h3><p>We owe suppliers " + rs(I.payTotal) + " · overdue " + rs(I.payOverdue) + " · due in the next 15 days " + rs(I.dueSoon) + ".</p>" +
    tbl(["Supplier", "Owed", "Overdue"], I.payables.slice(0, 12).map((p) => [esc(p.party), rs(p.amt), p.overdue ? "<b style='color:#b42318'>" + rs(p.overdue) + "</b> (" + p.oldest + " d)" : "—"]));
  h += "<p><a href='" + L.SITE + "/purchase/?user=main'>Open Purchases</a></p></div>";
  const s = D.s;
  const r = await require("./mail.js").handler({ httpMethod: "POST", body: JSON.stringify({ to: [s.ownerEmail], subject: "Purchases " + lastMonth + ": " + rs(cur) + (moves.filter((m) => m.pct > 10).length ? " · " + moves.filter((m) => m.pct > 10).length + " price rises over 10%" : ""), html: h }) });
  return { sent: JSON.parse(r.body || "{}").ok, month: lastMonth, total: cur };
}
exports.run = run;
exports.handler = async () => { try { return { statusCode: 200, body: JSON.stringify(await run({})) }; } catch (e) { return { statusCode: 200, body: String(e) }; } };
