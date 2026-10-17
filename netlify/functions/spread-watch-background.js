// Live watcher (runs ~13 minutes, restarted every 15 minutes in market hours).
// Streams top-5 depth for up to 100 stocks over Kite's WebSocket and measures,
// per stock: how long a profitable ("wide") gate lasts, how long the best bid
// and best offer stay unchanged, and how often trades print. Read-only.
const WebSocket = require("ws");
const S = require("./spreads-lib.js");
const T = require("./tally.js");
const RUN_MS = 13 * 60 * 1000;
function parse(buf) {   // Kite binary ticks → [{t, ltp, vol, bid, ask, bq, aq}]
  const out = []; if (buf.length < 2) return out;
  const n = buf.readInt16BE(0); let off = 2;
  for (let i = 0; i < n; i++) {
    const len = buf.readInt16BE(off); off += 2; const p = buf.subarray(off, off + len); off += len;
    if (len < 184) continue;               // only "full" packets carry depth
    const t = p.readInt32BE(0), div = 100;
    out.push({ t, ltp: p.readInt32BE(4) / div, vol: p.readInt32BE(16),
      bq: p.readInt32BE(64), bid: p.readInt32BE(68) / div, aq: p.readInt32BE(64 + 60), ask: p.readInt32BE(68 + 60) / div });
  }
  return out;
}
const med = (a) => { if (!a.length) return 0; const b = a.slice().sort((x, y) => x - y); return b[Math.floor(b.length / 2)]; };
const p90 = (a) => { if (!a.length) return 0; const b = a.slice().sort((x, y) => x - y); return b[Math.min(b.length - 1, Math.floor(b.length * 0.9))]; };
exports.handler = async (event) => {
  if ((event.headers || {})["x-run-key"] !== T.runKey()) return { statusCode: 403, body: "no" };
  const st = await S.settings(), cost = S.roundTripPct(st.tradeValue), wideAt = cost * st.wideMultiple;
  const token = await S.session();
  const live = { at: new Date().toISOString(), started: new Date().toISOString(), cost, wideAt, stats: [], error: "" };
  if (!token) { live.error = "Zerodha not logged in today — log in once in the AIM app"; await S.kvSet("spread_live", live); return { statusCode: 200, body: "no session" }; }
  // which stocks: your own list, or the screener's top 100
  let watch = [];
  try {
    const inst = await S.instruments(token), bySym = {}; inst.forEach((x) => { bySym[x.s] = x; });
    const syms = st.watchMode === "custom" && st.custom.length ? st.custom : ((await S.kvGet("spread_screen")) || { rows: [] }).rows.slice(0, 100).map((r) => r.s);
    watch = syms.map((s) => bySym[String(s).toUpperCase().trim()]).filter(Boolean).slice(0, 100);
  } catch (e) { live.error = e.message; }
  if (!watch.length) { live.error = live.error || "No stocks to watch yet — the screener runs every 5 minutes"; await S.kvSet("spread_live", live); return { statusCode: 200, body: "empty" }; }
  const byTok = {}; watch.forEach((w) => { byTok[w.t] = { s: w.s, tick: w.tick, ticks: 0, wideMs: 0, eps: [], wideStart: 0, bidLife: [], askLife: [], bidSince: 0, askSince: 0, lastBid: 0, lastAsk: 0, trades: 0, lastVol: -1, spreadSum: 0, n: 0, last: null, firstTs: 0, lastTs: 0 }; });
  const flush = async (final) => {
    const now = Date.now();
    live.stats = Object.values(byTok).map((x) => {
      const eps = x.eps.concat(x.wideStart ? [now - x.wideStart] : []).map((ms) => ms / 1000);
      const span = Math.max(1, now - (x.firstTs || now)) / 1000, wideSec = (x.wideMs + (x.wideStart ? now - x.wideStart : 0)) / 1000;
      return { s: x.s, ticks: x.n, last: x.last, avgPct: x.n ? Math.round(x.spreadSum / x.n * 100) / 100 : 0,
        widePctTime: Math.min(100, Math.round(wideSec / span * 1000) / 10), wideSec: Math.round(wideSec), spanSec: Math.round(span),
        episodes: eps.length, medWideSec: Math.round(med(eps)), p90WideSec: Math.round(p90(eps)), maxWideSec: Math.round(Math.max(0, ...eps)),
        medBidLifeSec: Math.round(med(x.bidLife) / 1000), medAskLifeSec: Math.round(med(x.askLife) / 1000),
        tradesPerMin: Math.round(x.trades / Math.max(1, span / 60) * 10) / 10, wideNow: !!x.wideStart };
    }).sort((a, b) => b.widePctTime - a.widePctTime || b.medWideSec - a.medWideSec);
    live.updated = new Date().toISOString(); live.final = !!final; live.watching = watch.length;
    await S.kvSet("spread_live", live);
    if (final) {   // add this session to today's totals
      const dayKey = "spread_day_" + S.istDay(), d = (await S.kvGet(dayKey)) || { sessions: 0, byStock: {} };
      d.sessions++; live.stats.forEach((r) => { const y = d.byStock[r.s] || (d.byStock[r.s] = { sessions: 0, wideSecTotal: 0, episodes: 0, medWideSec: [], trades: 0 });
        y.sessions++; y.episodes += r.episodes; y.medWideSec.push(r.medWideSec); y.wideSecTotal += r.wideSec || 0; y.trades += Math.round(r.tradesPerMin * (r.spanSec || 0) / 60); });
      await S.kvSet(dayKey, d);
    }
  };
  await new Promise((resolve) => {
    const ws = new WebSocket("wss://ws.kite.trade?api_key=" + S.API_KEY() + "&access_token=" + token);
    let timer = null, saver = null, finished = false;
    const done = () => { if (finished) return; finished = true; clearTimeout(timer); clearInterval(saver); try { ws.close(); } catch (e) {} resolve(); };
    ws.on("open", () => {
      const toks = watch.map((w) => w.t);
      ws.send(JSON.stringify({ a: "subscribe", v: toks })); ws.send(JSON.stringify({ a: "mode", v: ["full", toks] }));
      timer = setTimeout(done, RUN_MS); saver = setInterval(() => flush(false).catch(() => {}), 60000);
    });
    ws.on("message", (data, isBinary) => {
      if (!isBinary) return; const now = Date.now();
      parse(Buffer.from(data)).forEach((k) => {
        const x = byTok[k.t]; if (!x || !k.bid || !k.ask || k.ask <= k.bid) return;
        if (!x.firstTs) x.firstTs = now; x.lastTs = now; x.n++;
        const mid = (k.bid + k.ask) / 2, pct = (k.ask - k.bid) / mid * 100; x.spreadSum += pct;
        x.last = { bid: k.bid, ask: k.ask, pct: Math.round(pct * 100) / 100, ticks: Math.round((k.ask - k.bid) / (x.tick || 0.05)), bq: k.bq, aq: k.aq, ltp: k.ltp };
        if (k.bid !== x.lastBid) { if (x.bidSince) x.bidLife.push(now - x.bidSince); x.bidSince = now; x.lastBid = k.bid; }
        if (k.ask !== x.lastAsk) { if (x.askSince) x.askLife.push(now - x.askSince); x.askSince = now; x.lastAsk = k.ask; }
        if (x.lastVol >= 0 && k.vol > x.lastVol) x.trades++; x.lastVol = k.vol;
        const wide = pct >= wideAt;
        if (wide && !x.wideStart) x.wideStart = now;
        if (!wide && x.wideStart) { const ms = now - x.wideStart; x.eps.push(ms); x.wideMs += ms; x.wideStart = 0; }
      });
    });
    ws.on("error", (e) => { live.error = "WebSocket: " + (e.message || e); done(); });
    ws.on("close", () => done());
    setTimeout(done, RUN_MS + 30000);
  });
  await flush(true);
  return { statusCode: 200, body: "ok" };
};
