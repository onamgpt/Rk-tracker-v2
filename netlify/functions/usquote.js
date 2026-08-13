// Live prices for the USA book.
//
// Originally used Stooq, which stopped returning data. Yahoo is already proven
// in this codebase — the backtest has used it throughout — so this now goes
// through the same source rather than maintaining a second one.
const https = require("https");

function get(url) {
  return new Promise((resolve) => {
    https.get(url, {
      headers: { "User-Agent": "Mozilla/5.0", "Accept": "application/json" }
    }, (res) => {
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
    return { statusCode: 400, headers: h,
      body: JSON.stringify({ ok: false, error: "symbols required" }) };
  }

  const out = {};
  const failed = [];
  let lastError = null;

  // All at once. Yahoo tolerates this and the whole call has to finish inside
  // the function time limit.
  const results = await Promise.all(symbols.map(async (raw) => {
    const sym = String(raw).trim().toUpperCase();
    const url = "https://query1.finance.yahoo.com/v8/finance/chart/" +
      encodeURIComponent(sym) + "?interval=1d&range=5d";
    const r = await get(url);
    return { sym, r };
  }));

  results.forEach(({ sym, r }) => {
    if (r.status !== 200 || !r.body) {
      failed.push(sym);
      if (r.error) lastError = r.error;
      return;
    }
    try {
      const j = JSON.parse(r.body);
      const res = j && j.chart && j.chart.result && j.chart.result[0];
      const meta = res && res.meta;
      const price = meta && (meta.regularMarketPrice || meta.previousClose);
      if (price > 0) {
        out[sym] = {
          price: price,
          asOf: meta.regularMarketTime
            ? new Date(meta.regularMarketTime * 1000).toISOString().slice(0, 10)
            : ""
        };
      } else {
        failed.push(sym);
      }
    } catch (e) {
      failed.push(sym);
    }
  });

  return {
    statusCode: 200,
    headers: h,
    body: JSON.stringify({
      ok: Object.keys(out).length > 0,
      prices: out,
      failed,
      note: Object.keys(out).length ? null
        : ("no prices came back" + (lastError ? (" — " + lastError) : ""))
    })
  };
};
