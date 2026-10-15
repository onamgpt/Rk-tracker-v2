// Road distance between two points.
// 1st choice: Google Routes API (computeRoutes, driving, live road network).
// Fallback:   Google Distance Matrix API (legacy), if Routes isn't enabled.
// Results are cached in Supabase so the same trip isn't paid for twice.
// origin / destination: "lat,lng" or an address. Optional {cacheOnly} for tests.
const db = require("./db.js");
const call = async (b) => JSON.parse((await db.handler({ httpMethod: "POST", body: JSON.stringify(b) })).body || "{}");
const kvGet = async (k) => { const r = await call({ action: "getPortfolio", user: "main", key: k }); return r && r.data != null ? r.data : null; };
const kvSet = (k, d) => call({ action: "savePortfolio", user: "main", key: k, data: d });

const H = { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json", "Access-Control-Allow-Headers": "Content-Type", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const OK = (o) => ({ statusCode: 200, headers: H, body: JSON.stringify(o) });
const LL = /^\s*(-?\d{1,2}(?:\.\d+)?)\s*,\s*(-?\d{1,3}(?:\.\d+)?)\s*$/;
function waypoint(s) {
  const m = String(s).match(LL);
  return m ? { location: { latLng: { latitude: +m[1], longitude: +m[2] } } } : { address: String(s) };
}
function norm(s) { const m = String(s).match(LL); return m ? (+m[1]).toFixed(4) + "," + (+m[2]).toFixed(4) : String(s).trim().toLowerCase(); }

async function viaRoutes(key, origin, destination) {
  const r = await fetch("https://routes.googleapis.com/directions/v2:computeRoutes", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Goog-Api-Key": key, "X-Goog-FieldMask": "routes.distanceMeters,routes.duration" },
    body: JSON.stringify({ origin: waypoint(origin), destination: waypoint(destination), travelMode: "DRIVE", routingPreference: "TRAFFIC_UNAWARE", units: "METRIC" })
  });
  const j = await r.json().catch(() => ({}));
  const rt = j && j.routes && j.routes[0];
  if (!r.ok || !rt || rt.distanceMeters == null) return { ok: false, status: (j.error && (j.error.status || j.error.message)) || ("ROUTES_" + r.status) };
  return { ok: true, km: Math.round(rt.distanceMeters / 100) / 10, durationMin: Math.round(parseInt(String(rt.duration || "0").replace("s", ""), 10) / 60), source: "google-routes" };
}
async function viaMatrix(key, origin, destination) {
  const u = "https://maps.googleapis.com/maps/api/distancematrix/json?origins=" + encodeURIComponent(origin) + "&destinations=" + encodeURIComponent(destination) + "&mode=driving&units=metric&key=" + key;
  const r = await fetch(u); const j = await r.json().catch(() => ({}));
  const el = j && j.rows && j.rows[0] && j.rows[0].elements && j.rows[0].elements[0];
  if (!el || el.status !== "OK") return { ok: false, status: (el && el.status) || j.status || "UNKNOWN", detail: j.error_message || null };
  return { ok: true, km: Math.round(el.distance.value / 100) / 10, durationMin: Math.round(el.duration.value / 60), source: "google-distance-matrix",
    originText: j.origin_addresses && j.origin_addresses[0], destinationText: j.destination_addresses && j.destination_addresses[0] };
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers: H, body: "" };
  const key = process.env.google_maps_key || process.env.GOOGLE_MAPS_KEY || process.env.GOOGLE_PLACES_KEY;
  if (!key) return OK({ ok: false, reason: "google_maps_key not set" });
  let b = {}; try { b = JSON.parse(event.body || "{}"); } catch (e) {}
  const { origin, destination } = b;
  if (!origin || !destination) return { statusCode: 400, headers: H, body: JSON.stringify({ ok: false, error: "origin and destination required" }) };

  const ck = norm(origin) + "|" + norm(destination);
  let cache = null;
  try { cache = (await kvGet("dist_cache")) || {}; if (cache[ck]) return OK(Object.assign({ ok: true, cached: true }, cache[ck])); } catch (e) { cache = null; }

  let res = await viaRoutes(key, origin, destination);
  let routesErr = res.ok ? null : res.status;
  if (!res.ok) res = await viaMatrix(key, origin, destination);
  if (!res.ok) return OK({ ok: false, status: res.status, routes: routesErr, detail: res.detail || null });

  if (cache) {
    try {
      cache[ck] = { km: res.km, durationMin: res.durationMin, source: res.source, destinationText: res.destinationText || null, originText: res.originText || null, at: Date.now() };
      const keys = Object.keys(cache); if (keys.length > 3000) keys.sort((a, z) => (cache[a].at || 0) - (cache[z].at || 0)).slice(0, keys.length - 3000).forEach((k) => delete cache[k]);
      await kvSet("dist_cache", cache);
    } catch (e) {}
  }
  return OK(Object.assign({ ok: true }, res, routesErr ? { note: "Routes API not available (" + routesErr + "); used Distance Matrix" } : {}));
};
