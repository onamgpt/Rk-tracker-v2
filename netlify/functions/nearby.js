// Nearby Now — restaurants + attractions around a GPS point, via Google
// Places API (New). Key lives only in the Netlify env (GOOGLE_PLACES_KEY),
// never in the page. Key rotated 2026-09-28.
const https = require("https");

const H = {
  "Access-Control-Allow-Origin": "*",
  "Content-Type": "application/json",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "POST, OPTIONS"
};

const FIELDS = [
  "places.id", "places.displayName", "places.formattedAddress", "places.location",
  "places.rating", "places.userRatingCount", "places.primaryType",
  "places.primaryTypeDisplayName", "places.googleMapsUri", "places.editorialSummary",
  "places.servesVegetarianFood", "places.websiteUri", "places.priceLevel", "places.currentOpeningHours.openNow"
].join(",");

const VEG_TYPES = ["vegetarian_restaurant", "vegan_restaurant", "indian_restaurant"];

function post(body, key) {
  const payload = JSON.stringify(body);
  return new Promise((resolve) => {
    const req = https.request({
      hostname: "places.googleapis.com",
      path: "/v1/places:searchNearby",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload),
        "X-Goog-Api-Key": key,
        "X-Goog-FieldMask": FIELDS
      }
    }, (res) => {
      let d = "";
      res.on("data", c => d += c);
      res.on("end", () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(d) }); }
        catch (e) { resolve({ status: res.statusCode, body: { raw: d } }); }
      });
    });
    req.on("error", e => resolve({ status: 0, body: { error: String(e) } }));
    req.setTimeout(12000, () => { req.destroy(); resolve({ status: 0, body: { error: "timeout" } }); });
    req.write(payload);
    req.end();
  });
}

function km(a, b) {
  const R = 6371, r = x => x * Math.PI / 180;
  const dLat = r(b.lat - a.lat), dLng = r(b.lng - a.lng);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

function shape(p, here, kind) {
  const loc = p.location ? { lat: p.location.latitude, lng: p.location.longitude } : null;
  const type = p.primaryType || "";
  return {
    id: p.id,
    kind,
    name: (p.displayName && p.displayName.text) || "Unnamed",
    address: p.formattedAddress || "",
    rating: p.rating || null,
    reviews: p.userRatingCount || 0,
    type: (p.primaryTypeDisplayName && p.primaryTypeDisplayName.text) || type.replace(/_/g, " "),
    summary: (p.editorialSummary && p.editorialSummary.text) || "",
    veg: p.servesVegetarianFood === true || VEG_TYPES.includes(type),
    pureVeg: type === "vegetarian_restaurant" || type === "vegan_restaurant",
    openNow: p.currentOpeningHours ? p.currentOpeningHours.openNow : null,
    website: p.websiteUri || "",
    maps: p.googleMapsUri || (loc ? `https://maps.google.com/?q=${loc.lat},${loc.lng}` : ""),
    km: loc ? Math.round(km(here, loc) * 100) / 100 : null
  };
}


// Fallback: legacy Places API (Nearby Search, GET). Used when the key is not
// allowed to call Places API (New) — keys restricted to "Places API" only.
function get(path) {
  return new Promise((resolve) => {
    https.get({ hostname: "maps.googleapis.com", path }, (res) => {
      let d = "";
      res.on("data", c => d += c);
      res.on("end", () => { try { resolve(JSON.parse(d)); } catch (e) { resolve({ status: "PARSE_ERROR" }); } });
    }).on("error", e => resolve({ status: "REQUEST_ERROR", error_message: String(e) }))
      .setTimeout(12000, function () { this.destroy(); });
  });
}

function shapeLegacy(p, here, kind, vegHint) {
  const loc = p.geometry && p.geometry.location;
  const types = p.types || [];
  const nm = (p.name || "").toLowerCase();
  const pureVeg = /\b(pure veg|vegetarian|vegan|vegetariano|vegano)\b/.test(nm);
  return {
    id: p.place_id, kind, name: p.name || "Unnamed", address: p.vicinity || "",
    rating: p.rating || null, reviews: p.user_ratings_total || 0,
    type: (types[0] || "").replace(/_/g, " "), summary: "",
    veg: vegHint || pureVeg || /indian|veg/.test(nm), pureVeg,
    openNow: p.opening_hours ? p.opening_hours.open_now : null,
    maps: "https://www.google.com/maps/search/?api=1&query=" + encodeURIComponent(p.name || "") + "&query_place_id=" + p.place_id,
    km: loc ? Math.round(km(here, loc) * 100) / 100 : null
  };
}

async function legacySearch(here, radius, key) {
  const base = "/maps/api/place/nearbysearch/json?location=" + here.lat + "," + here.lng + "&radius=" + radius + "&key=" + key;
  const [food, veg, sights] = await Promise.all([
    get(base + "&type=restaurant&rankby=prominence"),
    get(base + "&type=restaurant&keyword=" + encodeURIComponent("vegetarian")),
    get(base + "&type=tourist_attraction&rankby=prominence")
  ]);
  const okS = r => r && (r.status === "OK" || r.status === "ZERO_RESULTS");
  if (![food, veg, sights].some(okS)) return { ok: false, error: (food && (food.error_message || food.status)) || "legacy failed" };
  const seen = new Set(), eat = [];
  (veg.results || []).forEach(p => { if (!seen.has(p.place_id)) { seen.add(p.place_id); eat.push(shapeLegacy(p, here, "eat", true)); } });
  (food.results || []).forEach(p => { if (!seen.has(p.place_id)) { seen.add(p.place_id); eat.push(shapeLegacy(p, here, "eat", false)); } });
  const see = (sights.results || []).filter(p => !seen.has(p.place_id)).map(p => shapeLegacy(p, here, "see", false));
  return { ok: true, eat, see };
}

// Fallback 2: OpenStreetMap via Overpass. Free, no key, no card. No ratings.
function overpass(host, query) {
  return new Promise((resolve, reject) => {
    const body = "data=" + encodeURIComponent(query);
    const req = https.request({
      hostname: host, path: "/api/interpreter", method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "Content-Length": Buffer.byteLength(body),
                 "User-Agent": "RKTravelDesk/1.0 (personal trip app)" }
    }, (res) => {
      let d = "";
      res.on("data", c => d += c);
      res.on("end", () => {
        if (res.statusCode !== 200) return reject(new Error(host + " " + res.statusCode));
        try { resolve(JSON.parse(d)); } catch (e) { reject(new Error(host + " bad json")); }
      });
    });
    req.on("error", reject);
    req.setTimeout(8500, () => { req.destroy(); reject(new Error(host + " timeout")); });
    req.write(body); req.end();
  });
}

function anyOk(promises) {
  return new Promise((resolve, reject) => {
    let left = promises.length, errs = [];
    promises.forEach(p => p.then(resolve, e => { errs.push(e.message); if (--left === 0) reject(new Error(errs.join("; "))); }));
  });
}

function shapeOsm(el, here) {
  const t = el.tags || {};
  const c = el.center || (el.lat != null ? { lat: el.lat, lon: el.lon } : null);
  if (!c || !t.name) return null;
  const loc = { lat: c.lat, lng: c.lon };
  const kind = t.amenity === "restaurant" ? "eat" : t.amenity === "cafe" ? "coffee"
    : (t.amenity === "ice_cream" || /^(pastry|bakery|confectionery)$/.test(t.shop || "")) ? "dessert" : "see";
  const isFood = kind === "eat";
  const cuisine = (t.cuisine || "").toLowerCase();
  const dv = t["diet:vegetarian"], dg = t["diet:vegan"];
  const pureVeg = isFood && (dv === "only" || dg === "only" || /vegetarian|vegan/.test(cuisine));
  const veg = isFood && (pureVeg || dv === "yes" || dg === "yes" || /indian/.test(cuisine));
  let type = kind === "coffee" ? "Cafe" : kind === "dessert" ? (t.shop || "ice cream").replace(/_/g, " ") : isFood ? (t.cuisine ? t.cuisine.split(";")[0].replace(/_/g, " ") + " restaurant" : "Restaurant")
    : (t.tourism || t.historic || (t.amenity === "place_of_worship" ? "place of worship" : "sight")).replace(/_/g, " ");
  const score = (t.wikipedia ? 2 : 0) + (t.wikidata ? 1 : 0) + (/attraction|museum/.test(t.tourism || "") ? 1 : 0);
  const addr = [t["addr:street"], t["addr:housenumber"], t["addr:city"]].filter(Boolean).join(" ");
  return {
    id: el.type + el.id, kind, name: t.name, address: addr, rating: null, reviews: 0, type,
    summary: (t.description || "").slice(0, 160), veg, pureVeg, openNow: null, _score: score,
    website: t["menu:url"] || t.website || t["contact:website"] || "",
    maps: "https://www.google.com/maps/search/?api=1&query=" + encodeURIComponent(t.name) + "%20" + loc.lat + "," + loc.lng,
    km: Math.round(km(here, loc) * 100) / 100
  };
}

async function osmSearch(here, radius) {
  const a = "(around:" + radius + "," + here.lat + "," + here.lng + ")";
  const q = "[out:json][timeout:8];(" +
    "nwr" + a + '["amenity"="restaurant"]["name"];' +
    "nwr" + a + '["tourism"~"^(attraction|museum|gallery|viewpoint)$"]["name"];' +
    "nwr" + a + '["historic"]["historic"!~"^(memorial|wayside_cross|wayside_shrine|boundary_stone|plaque|stolperstein|milestone)$"]["name"];' +
    "nwr" + a + '["amenity"="place_of_worship"]["name"]["wikipedia"];' +
    "nwr" + a + '["amenity"~"^(cafe|ice_cream)$"]["name"];' +
    "nwr" + a + '["shop"~"^(pastry|bakery|confectionery)$"]["name"];' +
    ");out center tags 250;";
  let data;
  try {
    data = await anyOk([overpass("overpass-api.de", q), overpass("overpass.kumi.systems", q)]);
  } catch (e) { return { ok: false, error: "OpenStreetMap: " + e.message }; }
  const seen = new Set(), items = [];
  (data.elements || []).forEach(el => {
    const it = shapeOsm(el, here);
    if (!it) return;
    const k = it.name.toLowerCase() + "|" + it.kind;
    if (seen.has(k)) return; seen.add(k); items.push(it);
  });
  const eat = items.filter(i => i.kind === "eat").sort((a, b) => (b.pureVeg - a.pureVeg) || (b.veg - a.veg) || a.km - b.km).slice(0, 40);
  const coffee = items.filter(i => i.kind === "coffee").sort((a, b) => a.km - b.km).slice(0, 30);
  const dessert = items.filter(i => i.kind === "dessert").sort((a, b) => a.km - b.km).slice(0, 30);
  const see = items.filter(i => i.kind === "see").sort((a, b) => (b._score - a._score) || a.km - b.km).slice(0, 40);
  const famous = see.length && see[0]._score > 0 ? see[0] : (see[0] || null);
  eat.concat(see, coffee, dessert).forEach(i => delete i._score);
  return { ok: true, eat, coffee, dessert, see, famousId: famous ? famous.id : null };
}

exports._osmTest = { shapeOsm, osmSearch };
exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers: H, body: "" };

  const key = process.env.GOOGLE_PLACES_KEY || process.env.google_maps_key || process.env.GOOGLE_MAPS_KEY;
  if (!key) return { statusCode: 200, headers: H, body: JSON.stringify({ ok: false, error: "GOOGLE_PLACES_KEY not set" }) };

  let b = {};
  try { b = JSON.parse(event.body || "{}"); } catch (e) {}
  const lat = Number(b.lat), lng = Number(b.lng);
  if (!isFinite(lat) || !isFinite(lng)) {
    return { statusCode: 400, headers: H, body: JSON.stringify({ ok: false, error: "lat and lng required" }) };
  }
  const radius = Math.min(Math.max(Number(b.radius) || 1500, 300), 5000);
  const here = { lat, lng };
  const area = { circle: { center: { latitude: lat, longitude: lng }, radius } };

  const [food, veg, sights, coffeeR, dessertR] = await Promise.all([
    post({ includedTypes: ["restaurant"], maxResultCount: 20, rankPreference: "POPULARITY", locationRestriction: area }, key),
    post({ includedTypes: VEG_TYPES, maxResultCount: 20, rankPreference: "POPULARITY", locationRestriction: area }, key),
    post({ includedTypes: ["tourist_attraction", "museum", "historical_landmark", "church", "hindu_temple", "park", "art_gallery"],
           maxResultCount: 20, rankPreference: "POPULARITY", locationRestriction: area }, key),
    post({ includedTypes: ["cafe", "coffee_shop"], maxResultCount: 20, rankPreference: "POPULARITY", locationRestriction: area }, key),
    post({ includedTypes: ["dessert_shop", "dessert_restaurant", "ice_cream_shop", "bakery", "confectionery"],
           maxResultCount: 20, rankPreference: "POPULARITY", locationRestriction: area }, key)
  ]);

  const bad = [food, veg, sights].find(r => r.status !== 200);
  if (bad && [food, veg, sights].every(r => r.status !== 200)) {
    const msg = (bad.body && bad.body.error && (bad.body.error.message || bad.body.error)) || "Places request failed";
    const L = await legacySearch(here, radius, key);
    if (!L.ok) {
      const O = await osmSearch(here, radius);
      if (!O.ok) {
        return { statusCode: 200, headers: H, body: JSON.stringify({ ok: false,
          error: "Google blocked (" + String(msg).slice(0, 80) + "). " + O.error }) };
      }
      return { statusCode: 200, headers: H, body: JSON.stringify({ ok: true, via: "osm", famousId: O.famousId, eat: O.eat, coffee: O.coffee, dessert: O.dessert, see: O.see }) };
    }
    const f = L.see.filter(p => (p.rating || 0) >= 4).sort((a, b) => b.reviews - a.reviews)[0]
      || L.see.slice().sort((a, b) => b.reviews - a.reviews)[0] || null;
    return { statusCode: 200, headers: H, body: JSON.stringify({ ok: true, via: "legacy", famousId: f ? f.id : null, eat: L.eat, see: L.see }) };
  }

  const seen = new Set();
  const eat = [];
  [food, veg].forEach(r => ((r.body && r.body.places) || []).forEach(p => {
    if (seen.has(p.id)) return; seen.add(p.id); eat.push(shape(p, here, "eat"));
  }));
  const see = ((sights.body && sights.body.places) || [])
    .filter(p => !seen.has(p.id)).map(p => shape(p, here, "see"));

  const coffee = ((coffeeR.body && coffeeR.body.places) || []).filter(p => !seen.has(p.id))
    .map(p => { seen.add(p.id); return shape(p, here, "coffee"); });
  const dessert = ((dessertR.body && dessertR.body.places) || []).filter(p => !seen.has(p.id))
    .map(p => { seen.add(p.id); return shape(p, here, "dessert"); });
  // "Most famous" = most-reviewed attraction with a decent rating.
  const famous = see.filter(p => (p.rating || 0) >= 4)
    .sort((a, b) => b.reviews - a.reviews)[0] || see.sort((a, b) => b.reviews - a.reviews)[0] || null;

  return {
    statusCode: 200,
    headers: H,
    body: JSON.stringify({ ok: true, famousId: famous ? famous.id : null, eat, coffee, dessert, see })
  };
};
