// Live prices for the USA book. Zerodha covers India only, so US holdings were
// valued at whatever price was last typed in — sometimes weeks stale, which
// makes every signal on that book wrong regardless of how good the arithmetic is.
//
// Uses Stooq, which needs no key and no account. Daily closing marks, which is
// the right resolution for AIM: it reviews positions, it does not day-trade.
const https = require("https");

function fetchCsv(path) {
  return new Promise((resolve) => {
    https.get({ hostname: "stooq.com", path, headers: { "User-Agent": "rk-tracker" } }, (res) => {
      let d = "";
      res.on("data", c => d += c);
      res.on("end", () => resolve({ status: res.statusCode, body: d }));
    }).on("error", e => resolve({ status: 0, body: "", error: String(e) }));
  });
}

exports.handler = async (event) => {
  const h = {
    "Access-Control-Allow-Origin": "*",
    "Content-Type": "application/json",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS"
  };
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers: h, body: "" };

  let body = {};
  try { body = JSON.parse(event.body || "{}"); } catch (e) {}
  const symbols = (body.symbols || []).filter(Boolean);
  if (!symbols.length) {
    return { statusCode: 400, headers: h, body: JSON.stringify({ ok: false, error: "symbols required" }) };
  }

  const out = {};
  const failed = [];

  for (let i = 0; i < symbols.length; i++) {
    const raw = String(symbols[i]).trim().toUpperCase();
    // Stooq wants US tickers suffixed .us
    const q = raw.toLowerCase().replace(/\.US$/i, "") + ".us";
    const r = await fetchCsv("/q/l/?s=" + encodeURIComponent(q) + "&f=sd2t2ohlcv&h&e=csv");

    if (r.status !== 200 || !r.body) { failed.push(raw); continue; }

    // Symbol,Date,Time,Open,High,Low,Close,Volume
    const lines = r.body.trim().split("\n");
    if (lines.length < 2) { failed.push(raw); continue; }
    const cols = lines[1].split(",");
    const close = parseFloat(cols[6]);
    const date = cols[1];

    if (!isFinite(close) || close <= 0) { failed.push(raw); continue; }
    out[raw] = { price: close, asOf: date };
  }

  return {
    statusCode: 200,
    headers: h,
    body: JSON.stringify({ ok: true, prices: out, failed })
  };
};
