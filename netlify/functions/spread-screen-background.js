// Every few minutes in market hours: snapshot the whole NSE equity list
// (Kite /quote, 500 per call), rank by gate width vs. round-trip cost,
// and pick the 100 to watch live.
const S = require("./spreads-lib.js");
const T = require("./tally.js");
exports.handler = async (event) => {
  if ((event.headers || {})["x-run-key"] !== T.runKey()) return { statusCode: 403, body: "no" };
  const st = await S.settings(), cost = S.roundTripPct(st.tradeValue);
  const out = { at: new Date().toISOString(), cost, rows: [], error: "" };
  try {
    const token = await S.session(); if (!token) throw new Error("Zerodha not logged in today — log in once in the AIM app");
    const inst = await S.instruments(token), bySym = {};
    inst.forEach((x) => { bySym[x.s] = x; });
    for (let i = 0; i < inst.length; i += 500) {
      const qs = inst.slice(i, i + 500).map((x) => "i=" + encodeURIComponent("NSE:" + x.s)).join("&");
      let j; try { j = await S.kite("/quote?" + qs, token); } catch (e) { out.error = e.message; break; }
      for (const k in (j.data || {})) {
        const q = j.data[k], sym = k.slice(4), meta = bySym[sym] || {};
        if (!q.last_price || q.last_price < st.minPrice || (q.volume || 0) < st.minVolume) continue;
        const g = S.gateOf(q, meta.tick, cost); if (!g) continue;
        out.rows.push(Object.assign({ s: sym, n: meta.n || "", t: meta.t, ltp: q.last_price, vol: q.volume }, g));
      }
      await new Promise((r) => setTimeout(r, 1100));   // Kite quote limit ~1 request/second
    }
    out.rows.sort((a, b) => b.edge - a.edge);
    out.universe = inst.length; out.rows = out.rows.slice(0, 300);
  } catch (e) { out.error = e.message; }
  await S.kvSet("spread_screen", out);
  // keep a light history of how often each name shows a profitable gate
  try {
    const h = (await S.kvGet("spread_screen_hist")) || { day: S.istDay(), runs: 0, seen: {} };
    if (h.day !== S.istDay()) { h.day = S.istDay(); h.runs = 0; h.seen = {}; }
    if (out.rows.length) { h.runs++; out.rows.forEach((r) => { if (r.edge >= st.wideMultiple) { const x = h.seen[r.s] || (h.seen[r.s] = { n: 0, best: 0 }); x.n++; x.best = Math.max(x.best, r.edge); } }); }
    await S.kvSet("spread_screen_hist", h);
  } catch (e) {}
  return { statusCode: 200, body: "ok" };
};
