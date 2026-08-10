// Weather for a travel date.
//
// Near dates get a real forecast. Anything beyond the forecast horizon gets the
// average of the same calendar date over the last three years, which is what
// "typical for that time of year" actually means. Open-Meteo needs no key and
// no account, so this keeps working without anything to renew or pay for.
const https = require("https");

function getJson(host, path) {
  return new Promise((resolve) => {
    https.get({ hostname: host, path, headers: { "User-Agent": "rk-tracker" } }, (res) => {
      let d = "";
      res.on("data", c => d += c);
      res.on("end", () => {
        try { resolve(JSON.parse(d)); } catch (e) { resolve(null); }
      });
    }).on("error", () => resolve(null));
  });
}

const round = (n) => (n === null || n === undefined || isNaN(n)) ? null : Math.round(n);

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

  // [{ key, lat, lon, date }]
  const asks = Array.isArray(body.places) ? body.places.slice(0, 30) : [];
  if (!asks.length) {
    return { statusCode: 400, headers: h, body: JSON.stringify({ ok: false, error: "places required" }) };
  }

  const today = new Date();
  const out = {};

  for (let i = 0; i < asks.length; i++) {
    const a = asks[i];
    if (!a || a.lat === undefined || !a.date) continue;

    const target = new Date(a.date + "T00:00:00Z");
    const daysAway = Math.round((target - today) / 86400000);

    // Within the forecast window: ask for the actual forecast.
    if (daysAway >= -1 && daysAway <= 15) {
      const p = "/v1/forecast?latitude=" + a.lat + "&longitude=" + a.lon +
        "&daily=temperature_2m_max,temperature_2m_min,precipitation_sum" +
        "&timezone=auto&start_date=" + a.date + "&end_date=" + a.date;
      const j = await getJson("api.open-meteo.com", p);
      const d = j && j.daily;
      if (d && d.temperature_2m_max && d.temperature_2m_max.length) {
        out[a.key] = {
          kind: "forecast",
          high: round(d.temperature_2m_max[0]),
          low: round(d.temperature_2m_min[0]),
          rain: d.precipitation_sum ? Math.round((d.precipitation_sum[0] || 0) * 10) / 10 : 0
        };
        continue;
      }
    }

    // Too far ahead to forecast. Average the same date across recent years.
    const md = a.date.slice(4);            // -MM-DD
    const years = [1, 2, 3].map(n => target.getUTCFullYear() - n);
    let highs = 0, lows = 0, rains = 0, n = 0;

    for (let y = 0; y < years.length; y++) {
      const day = years[y] + md;
      const p = "/v1/archive?latitude=" + a.lat + "&longitude=" + a.lon +
        "&daily=temperature_2m_max,temperature_2m_min,precipitation_sum" +
        "&timezone=auto&start_date=" + day + "&end_date=" + day;
      const j = await getJson("archive-api.open-meteo.com", p);
      const d = j && j.daily;
      if (d && d.temperature_2m_max && d.temperature_2m_max[0] !== null && d.temperature_2m_max[0] !== undefined) {
        highs += d.temperature_2m_max[0];
        lows += d.temperature_2m_min[0];
        rains += (d.precipitation_sum && d.precipitation_sum[0]) || 0;
        n++;
      }
    }

    if (n > 0) {
      out[a.key] = {
        kind: "typical",
        years: n,
        high: round(highs / n),
        low: round(lows / n),
        rain: Math.round((rains / n) * 10) / 10
      };
    }
  }

  return { statusCode: 200, headers: h, body: JSON.stringify({ ok: true, weather: out }) };
};
