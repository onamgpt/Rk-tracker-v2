// Every 3 minutes in market hours: snapshot the bid/ask gate for the watchlist
// (Zerodha quote, top 5 levels) and keep running stats per stock for the day.
// Read-only — never places orders.
const S = require("./spreads.js");
function costPct(v, price) {   // Zerodha intraday round trip, as % of trade value
  const brk = Math.min(20, v * 0.0003) * 2, stt = v * 0.00025, txn = v * 2 * 0.0000297, stamp = v * 0.00003, sebi = v * 2 * 0.000001, gst = (brk + txn + sebi) * 0.18;
  return (brk + stt + txn + stamp + sebi + gst) / v * 100;
}
exports.costPct = costPct;
exports.handler = async () => {
  const now = new Date(Date.now() + 5.5 * 3600e3), hm = now.getUTCHours() * 60 + now.getUTCMinutes(), dow = now.getUTCDay();
  if (dow === 0 || dow === 6 || hm < 9 * 60 + 15 || hm > 15 * 60 + 30) return { statusCode: 200, body: "closed" };
  const day = S.istDay();
  const [settings, sess] = await Promise.all([S.kvGet("spread_settings"), S.kvGet("kite_session")]);
  const st = Object.assign({ list: S.DEFAULT_LIST, tradeValue: 100000, multiple: 2, minTicks: 2 }, settings || {});
  if (!sess || !sess.token || sess.day !== day) { if (sess && !sess.error) { sess.error = "Zerodha login is from " + sess.day + " — open Spread Lab after logging in today"; await S.kvSet("kite_session", sess); } return { statusCode: 200, body: "no token" }; }
  const q = await S.quote(st.list, sess.token);
  if (q.status !== "success") { sess.error = q.authError || "quote failed"; await S.kvSet("kite_session", sess); return { statusCode: 200, body: "quote failed" }; }
  if (sess.error) { delete sess.error; await S.kvSet("kite_session", sess); }
  const key = "spread_screen_" + day, agg = (await S.kvGet(key)) || { day, runs: 0, symbols: {} };
  agg.runs++; agg.last = new Date().toISOString();
  const cost = costPct(st.tradeValue);
  Object.keys(q.data || {}).forEach((k) => {
    const d = q.data[k], sym = k.replace("NSE:", ""), b = d.depth && d.depth.buy && d.depth.buy[0], a = d.depth && d.depth.sell && d.depth.sell[0];
    if (!b || !a || !b.price || !a.price) return;
    const mid = (a.price + b.price) / 2, spread = a.price - b.price, pct = spread / mid * 100;
    const x = agg.symbols[sym] || (agg.symbols[sym] = { n: 0, wide: 0, sumPct: 0, maxPct: 0, minPct: 1e9, firstVol: d.volume, vol: d.volume, samples: [] });
    x.n++; x.sumPct += pct; x.maxPct = Math.max(x.maxPct, pct); x.minPct = Math.min(x.minPct, pct); x.vol = d.volume; x.ltp = d.last_price;
    if (pct >= cost * st.multiple) x.wide++;
    x.samples.push([now.toISOString().slice(11, 16), +b.price.toFixed(2), +a.price.toFixed(2), +pct.toFixed(3), b.quantity, a.quantity]);
    if (x.samples.length > 140) x.samples.shift();
  });
  agg.costPct = cost; agg.threshold = cost * st.multiple;
  await S.kvSet(key, agg);
  return { statusCode: 200, body: "ok" };
};
