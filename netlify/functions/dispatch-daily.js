// 18:00 IST daily: cartons loaded today per order, and open orders still waiting, to Prakash and Ravi.
const D = require("./dispatch.js");
const P = require("./purchase-lib.js");
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const TH = "style='text-align:left;padding:6px 7px;border-bottom:2px solid #ccc;font-size:13px'", TD = "style='padding:6px 7px;border-bottom:1px solid #e5e5e5;font-size:13px'";

async function run(opt) {
  opt = opt || {};
  const s = await P.settings(); const lg = (await D.kvGet("logistics_settings")) || {};
  const prakashEmail = lg.prakashEmail || "prakashonam@gmail.com";
  const loads = await D.loadLoads(); const today = D.todayIST();
  const todays = loads.map((L) => ({ L, n: L.loaded.filter((x) => x.d === today).length })).filter((x) => x.n > 0);
  const cartonsToday = todays.reduce((t, x) => t + x.n, 0);
  const open = loads.filter((L) => L.total && L.loaded.length < L.total);
  const completedToday = loads.filter((L) => L.total && L.loaded.length === L.total && L.loaded.some((x) => x.d === today));
  if (!todays.length && !opt.force && !open.length) return { skipped: "nothing loaded or open" };
  const rowsToday = todays.map((x) => "<tr><td " + TD + ">" + esc(x.L.orderNo || "") + "</td><td " + TD + "><b>" + esc(x.L.customer || "") + "</b></td><td " + TD + ">" + esc(x.L.invoice || "—") + "</td><td " + TD + "><b>" + x.n + "</b> cartons</td><td " + TD + ">" + x.L.loaded.length + " of " + x.L.total + "</td></tr>").join("");
  const rowsOpen = open.map((L) => "<tr><td " + TD + ">" + esc(L.orderNo || "") + "</td><td " + TD + ">" + esc(L.customer || "") + "</td><td " + TD + ">" + esc(L.invoice || "—") + "</td><td " + TD + ">" + L.loaded.length + " of " + L.total + "</td><td " + TD + ">" + (L.total - L.loaded.length) + " left</td></tr>").join("");
  const html = "<div style='font-family:Arial,sans-serif;font-size:15px;color:#16181c;max-width:760px'>" +
    "<p><b>Dispatch, " + esc(today) + "</b></p><p><b>" + cartonsToday + "</b> cartons loaded today across " + todays.length + " order(s)" + (completedToday.length ? ", " + completedToday.length + " order(s) fully loaded" : "") + ".</p>" +
    (todays.length ? "<h3 style='margin:16px 0 6px'>Loaded today</h3><table style='border-collapse:collapse;width:100%'><tr><th " + TH + ">Order</th><th " + TH + ">Customer</th><th " + TH + ">Invoice</th><th " + TH + ">Today</th><th " + TH + ">Total so far</th></tr>" + rowsToday + "</table>" : "<p>No cartons loaded today.</p>") +
    (open.length ? "<h3 style='margin:16px 0 6px'>Still loading (" + open.length + ")</h3><table style='border-collapse:collapse;width:100%'><tr><th " + TH + ">Order</th><th " + TH + ">Customer</th><th " + TH + ">Invoice</th><th " + TH + ">Loaded</th><th " + TH + ">Left</th></tr>" + rowsOpen + "</table>" : "") +
    "</div>";
  const subject = "Dispatch " + today + ": " + cartonsToday + " cartons loaded" + (completedToday.length ? ", " + completedToday.length + " complete" : "");
  const to = [prakashEmail, s.ownerEmail].filter(Boolean);
  const r = await require("./mail.js").handler({ httpMethod: "POST", body: JSON.stringify({ to, subject, html }) });
  return { sent: JSON.parse(r.body || "{}").ok ? to : "failed", cartons: cartonsToday };
}
exports.run = run;
exports.handler = async () => { try { return { statusCode: 200, body: JSON.stringify(await run({})) }; } catch (e) { return { statusCode: 200, body: String(e) }; } };
