// Road distance between two points. Uses Google Distance Matrix rather than
// a straight-line calculation because in Kerala the crow-flies figure is
// badly misleading — rivers and backwaters mean 25 km apart on the map can
// be 60 km by road, and the allowance has to follow the road.
const https = require("https");

exports.handler = async (event) => {
  const h = {
    "Access-Control-Allow-Origin": "*",
    "Content-Type": "application/json",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS"
  };
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers: h, body: "" };

  const key = process.env.google_maps_key || process.env.GOOGLE_MAPS_KEY;
  if (!key) {
    return { statusCode: 200, headers: h,
      body: JSON.stringify({ ok: false, reason: "google_maps_key not set" }) };
  }

  let body = {};
  try { body = JSON.parse(event.body || "{}"); } catch (e) {}
  const { origin, destination } = body;
  if (!origin || !destination) {
    return { statusCode: 400, headers: h,
      body: JSON.stringify({ ok: false, error: "origin and destination required" }) };
  }

  const path = "/maps/api/distancematrix/json"
    + "?origins=" + encodeURIComponent(origin)
    + "&destinations=" + encodeURIComponent(destination)
    + "&mode=driving&units=metric&key=" + key;

  const call = () => new Promise((resolve) => {
    https.get({ hostname: "maps.googleapis.com", path }, (res) => {
      let d = "";
      res.on("data", c => d += c);
      res.on("end", () => {
        try { resolve(JSON.parse(d)); } catch (e) { resolve({ status: "PARSE_ERROR", raw: d }); }
      });
    }).on("error", e => resolve({ status: "REQUEST_ERROR", error: String(e) }));
  });

  const r = await call();
  const el = r && r.rows && r.rows[0] && r.rows[0].elements && r.rows[0].elements[0];

  if (!el || el.status !== "OK") {
    return { statusCode: 200, headers: h,
      body: JSON.stringify({ ok: false, status: (el && el.status) || r.status || "UNKNOWN", detail: r.error_message || null }) };
  }

  const km = el.distance.value / 1000;
  return {
    statusCode: 200,
    headers: h,
    body: JSON.stringify({
      ok: true,
      km: Math.round(km * 10) / 10,
      durationMin: Math.round(el.duration.value / 60),
      originText: r.origin_addresses && r.origin_addresses[0],
      destinationText: r.destination_addresses && r.destination_addresses[0]
    })
  };
};
