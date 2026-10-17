// Spread scanner — read-only market data from Zerodha (Kite Connect).
// No orders are ever placed. Measures how wide the bid/ask "gate" is,
// whether it beats round-trip costs, and how long wide gates last.
const db = require("./db.js");
const call = async (b) => JSON.parse((await db.handler({ httpMethod: "POST", body: JSON.stringify(b) })).body || "{}");
const kvGet = async (k) => { const r = await call({ action: "getPortfolio", user: "main", key: k }); return r && r.data != null ? r.data : null; };
const kvSet = (k, d) => call({ action: "savePortfolio", user: "main", key: k, data: d });
const API_KEY = () => String(process.env.KITE_API_KEY || "").trim();
const istNow = () => new Date(Date.now() + 5.5 * 3600e3);
const istDay = () => istNow().toISOString().slice(0, 10);
const DEFAULTS = { tradeValue: 100000, wideMultiple: 2, minPrice: 20, minVolume: 50000, watchMode: "auto", custom: [] };
async function settings() { return Object.assign({}, DEFAULTS, (await kvGet("spread_settings")) || {}); }

// Zerodha intraday equity costs for a buy + sell of `v` rupees each (approx.)
function roundTripPct(v) {
  const brokerage = 2 * Math.min(20, 0.0003 * v), stt = 0.00025 * v, txn = 0.0000297 * 2 * v, sebi = 0.000001 * 2 * v, stamp = 0.00003 * v;
  const gst = 0.18 * (brokerage + txn + sebi);
  return (brokerage + stt + txn + sebi + stamp + gst) / v * 100;
}
async function session() {
  const s = await kvGet("kite_session");
  if (!s || !s.token) return null;
  // Zerodha sessions end around 6 am IST each day
  const born = new Date(new Date(s.at).getTime() + 5.5 * 3600e3), now = istNow();
  const cut = new Date(now); cut.setUTCHours(6, 0, 0, 0); if (now < cut) cut.setUTCDate(cut.getUTCDate() - 1);
  return born >= cut ? s.token : null;
}
async function kite(path, token) {
  const r = await fetch("https://api.kite.trade" + path, { headers: { "X-Kite-Version": "3", Authorization: "token " + API_KEY() + ":" + token } });
  const ct = r.headers.get("content-type") || "";
  if (/json/.test(ct)) { const j = await r.json(); if (j.status === "error") throw new Error(j.message || "Kite error"); return j; }
  const t = await r.text(); if (!r.ok) throw new Error("Kite " + r.status); return t;
}
// NSE equity list (refreshed daily)
async function instruments(token) {
  const c = await kvGet("spread_inst");
  if (c && c.day === istDay() && c.list && c.list.length) return c.list;
  const csv = await kite("/instruments/NSE", token);
  const lines = String(csv).split("\n"); const head = lines[0].split(",");
  const ix = (n) => head.indexOf(n);
  const iT = ix("instrument_token"), iS = ix("tradingsymbol"), iTick = ix("tick_size"), iType = ix("instrument_type"), iSeg = ix("segment"), iName = ix("name");
  const list = [];
  for (let i = 1; i < lines.length; i++) {
    const c2 = lines[i].split(","); if (c2.length < head.length) continue;
    if (c2[iType] !== "EQ" || c2[iSeg] !== "NSE") continue;
    const sym = c2[iS]; if (/-(BE|BZ|SM|ST|GB|SG|N\d|RR|IV|E1|MF)$/i.test(sym)) continue;
    list.push({ s: sym, t: +c2[iT], tick: +c2[iTick] || 0.05, n: (c2[iName] || "").replace(/"/g, "").slice(0, 40) });
  }
  await kvSet("spread_inst", { day: istDay(), list });
  return list;
}
function gateOf(q, tick, cost) {
  const b = q && q.depth && q.depth.buy && q.depth.buy[0], a = q && q.depth && q.depth.sell && q.depth.sell[0];
  if (!b || !a || !b.price || !a.price || a.price <= b.price) return null;
  const mid = (a.price + b.price) / 2, sp = a.price - b.price;
  return { bid: b.price, ask: a.price, bidQty: b.quantity, askQty: a.quantity, spread: Math.round(sp * 100) / 100, pct: Math.round(sp / mid * 10000) / 100,
    ticks: Math.round(sp / (tick || 0.05)), edge: Math.round((sp / mid * 100) / cost * 10) / 10 };
}
module.exports = { kvGet, kvSet, settings, roundTripPct, session, kite, instruments, gateOf, istNow, istDay, API_KEY, DEFAULTS };
