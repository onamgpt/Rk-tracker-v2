// 19:00 IST daily, to Ravi only: today's inward / issues / returns by material, live store stock below minimum,
// perfume & chemical drums open more than 30 days. Mondays: scanned stock vs Tally stock.
const L = require("./purchase-lib.js");
const I = require("./inventory.js");
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const f = (n) => (Math.round(n * 100) / 100).toLocaleString("en-IN");
const TH = "style='text-align:left;padding:6px 7px;border-bottom:2px solid #ccc;font-size:13px'", TD = "style='padding:6px 7px;border-bottom:1px solid #e5e5e5;font-size:13px'";
const tbl = (h, rows) => "<table style='border-collapse:collapse;width:100%'><tr>" + h.map((x) => "<th " + TH + ">" + x + "</th>").join("") + "</tr>" + rows.map((r) => "<tr>" + r.map((c) => "<td " + TD + ">" + c + "</td>").join("") + "</tr>").join("") + "</table>";

async function run(opt) {
  opt = opt || {};
  const lots = (await L.kvGet("inv_lots")) || [];
  const s = await L.settings(), items = (await L.kvGet("purchase_items")) || {};
  const today = L.todayIST();
  const ev = []; lots.forEach((l) => l.ev.forEach((e) => { if (e.d === today) ev.push(Object.assign({ item: l.item, unit: l.unit, supplier: l.supplier }, e)); }));
  if (!ev.length && !opt.force && new Date(Date.now() + 5.5 * 3600e3).getUTCDay() !== 1) return { skipped: "no scans today" };
  const agg = (t) => { const o = {}; ev.filter((e) => e.t === t).forEach((e) => { const k = e.item + "|" + e.unit; const a = o[k] = o[k] || { item: e.item, unit: e.unit, q: 0, n: 0, sup: new Set(), by: new Set() }; a.q += e.q; a.n++; if (e.supplier) a.sup.add(e.supplier); a.by.add(I.NAMES[e.by] || e.by); }); return Object.values(o); };
  const inw = agg("in"), iss = agg("issue"), ret = agg("return"), used = ev.filter((e) => e.t === "used");
  const st = I.stock(lots);
  const low = st.filter((x) => items[x.item] && +items[x.item].min > 0 && x.store < +items[x.item].min);
  const oldDrums = lots.filter((l) => l.status === "issued" && l.cat === "perfume" && L.daysBetween(l.ev[l.ev.length - 1].d, today) > 30);
  let h = "<div style='font-family:Arial,sans-serif;font-size:15px;color:#16181c;max-width:760px'><p><b>Inventory — " + esc(today) + "</b></p>";
  h += "<h3>Received at the gate</h3>" + (inw.length ? tbl(["Material", "Quantity", "Packages", "Supplier"], inw.map((a) => [esc(a.item), f(a.q) + " " + esc(a.unit), a.n, esc(Array.from(a.sup).join(", "))])) : "<p>Nothing received today.</p>");
  h += "<h3>Issued to departments (counted as consumed)</h3>" + (iss.length ? tbl(["Material", "Quantity", "Packages", "By"], iss.map((a) => [esc(a.item), f(a.q) + " " + esc(a.unit), a.n, esc(Array.from(a.by).join(", "))])) : "<p>Nothing issued today.</p>");
  if (ret.length) h += "<h3>Returned to store</h3>" + tbl(["Material", "Quantity back", "Packages"], ret.map((a) => [esc(a.item), f(a.q) + " " + esc(a.unit), a.n]));
  if (used.length) h += "<p>" + used.length + " drum(s)/package(s) marked fully used today.</p>";
  if (low.length) h += "<h3 style='color:#b42318'>Store stock below minimum</h3>" + tbl(["Material", "In store", "Minimum"], low.map((x) => [esc(x.item), f(x.store) + " " + esc(x.unit), f(+items[x.item].min)]));
  if (oldDrums.length) h += "<h3>Perfume / chemical drums open over 30 days</h3>" + tbl(["Material", "Left", "Issued on"], oldDrums.map((l) => [esc(l.item), f(l.qty) + " " + esc(l.unit), esc(l.ev[l.ev.length - 1].d)]));
  // Mondays: scanned stock vs Tally
  const dow = new Date(Date.now() + 5.5 * 3600e3).getUTCDay();
  if (dow === 1 || opt.force) {
    const ts = (await L.kvGet("tally_stock")) || {}; const tr = ts.rows || [];
    const diff = st.map((x) => { const t = tr.find((r) => L.norm(r.item) === L.norm(x.item)); if (!t) return null; const scan = x.store; const d = scan - (t.qty || 0);
      return Math.abs(d) > Math.max(1, 0.05 * Math.max(scan, t.qty || 0)) ? [esc(x.item), f(scan) + " " + esc(x.unit), f(t.qty || 0) + " " + esc(t.unit || ""), "<b>" + (d > 0 ? "+" : "") + f(d) + "</b>"] : null; }).filter(Boolean);
    h += "<h3>Scanned stock vs Tally" + (ts.asof ? " (Tally as of " + esc(ts.asof) + ")" : "") + "</h3>" + (!tr.length ? "<p>No Tally Stock Summary received yet.</p>" : diff.length ? tbl(["Material", "By scan", "In Tally", "Difference"], diff) : "<p>Scanned stock matches Tally within 5%.</p>");
  }
  h += "<p><a href='" + L.SITE + "/inventory/?user=main'>Open Inventory</a></p></div>";
  const r = await require("./mail.js").handler({ httpMethod: "POST", body: JSON.stringify({ to: [s.ownerEmail], subject: "Inventory " + today + ": " + inw.reduce((t, a) => t + a.n, 0) + " packages in, " + iss.reduce((t, a) => t + a.n, 0) + " issued" + (low.length ? ", " + low.length + " below minimum" : ""), html: h }) });
  return { sent: JSON.parse(r.body || "{}").ok };
}
exports.run = run;
exports.handler = async () => { try { return { statusCode: 200, body: JSON.stringify(await run({})) }; } catch (e) { return { statusCode: 200, body: String(e) }; } };
