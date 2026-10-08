// Travel Desk back end: AI trip planner (job + poll), live flight & hotel
// prices via SerpApi (Google Flights / Google Hotels), daily fare watches,
// travel reminders, and a Drive proxy so the trip PDF can bind vouchers in.
const db = require("./db.js");
const smart = require("./smartnote.js");

const H = { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json", "Access-Control-Allow-Headers": "Content-Type" };
const OK = (o) => ({ statusCode: 200, headers: H, body: JSON.stringify(o) });
const call = async (b) => JSON.parse((await db.handler({ httpMethod: "POST", body: JSON.stringify(b) })).body || "{}");
const kvGet = async (key) => { const r = await call({ action: "getPortfolio", user: "main", key }); return r && r.data != null ? r.data : null; };
const kvSet = async (key, data) => call({ action: "savePortfolio", user: "main", key, data });
const genId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

// ── SerpApi ─────────────────────────────────────────────────────────────────
async function serp(params) {
  const key = process.env.SERPAPI_KEY;
  if (!key) { const e = new Error("SERPAPI_KEY missing"); e.code = "nokey"; throw e; }
  const q = new URLSearchParams(Object.assign({ api_key: key, hl: "en", gl: "in", currency: "INR" }, params));
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 8500);
  try {
    const r = await fetch("https://serpapi.com/search.json?" + q.toString(), { signal: ctl.signal });
    const j = await r.json();
    if (j.error) throw new Error(j.error);
    return j;
  } finally { clearTimeout(t); }
}

function flightParams(legs) {
  const L = legs.filter(l => l && l.from && l.to && l.date);
  if (!L.length) throw new Error("no legs");
  if (L.length === 2 && L[1].from === L[0].to && L[1].to === L[0].from)
    return { engine: "google_flights", type: "1", departure_id: L[0].from, arrival_id: L[0].to, outbound_date: L[0].date, return_date: L[1].date, adults: "1" };
  if (L.length === 1)
    return { engine: "google_flights", type: "2", departure_id: L[0].from, arrival_id: L[0].to, outbound_date: L[0].date, adults: "1" };
  return { engine: "google_flights", type: "3", adults: "1",
    multi_city_json: JSON.stringify(L.map(l => ({ departure_id: l.from, arrival_id: l.to, date: l.date }))) };
}

// Prices are fetched for ONE adult so the per-person fare is unambiguous.
async function flights(legs) {
  const j = await serp(flightParams(legs));
  const all = [].concat(j.best_flights || [], j.other_flights || []);
  const opts = all.filter(o => o && o.price).slice(0, 8).map(o => {
    const segs = o.flights || [];
    return {
      price: o.price,
      airlines: [...new Set(segs.map(s => s.airline))].join(" + "),
      flights: segs.map(s => (s.flight_number || "") + " " + (s.departure_airport && s.departure_airport.id || "") + "→" + (s.arrival_airport && s.arrival_airport.id || "")).join(", "),
      depart: segs[0] && segs[0].departure_airport && segs[0].departure_airport.time || "",
      arrive: segs.length && segs[segs.length - 1].arrival_airport && segs[segs.length - 1].arrival_airport.time || "",
      hours: o.total_duration ? Math.round(o.total_duration / 6) / 10 : null,
      stops: Math.max(0, segs.length - 1),
      layovers: (o.layovers || []).map(l => (l.id || l.name) + " " + Math.round((l.duration || 0) / 6) / 10 + "h").join(", ")
    };
  });
  const pi = j.price_insights || {};
  return { options: opts, lowest: pi.lowest_price || (opts[0] && Math.min.apply(null, opts.map(o => o.price))) || null,
    typical: pi.typical_price_range || null, level: pi.price_level || "", link: (j.search_metadata && j.search_metadata.google_flights_url) || "" };
}

async function hotelPrice(name, city, checkin, checkout, adults) {
  const j = await serp({ engine: "google_hotels", q: (name + " " + (city || "")).trim(), check_in_date: checkin, check_out_date: checkout, adults: String(adults || 2) });
  const p = j.properties && j.properties.length ? j.properties[0] : j; // a named hotel returns itself at the top level
  const nightly = p.rate_per_night && (p.rate_per_night.extracted_lowest || null);
  const total = p.total_rate && (p.total_rate.extracted_lowest || null);
  return { name: p.name || name, perNight: nightly, total, rating: p.overall_rating || null, reviews: p.reviews || null,
    stars: p.extracted_hotel_class || null, link: p.link || "", deals: (p.prices || []).slice(0, 3).map(x => ({ source: x.source, perNight: x.rate_per_night && x.rate_per_night.extracted_lowest })) };
}

// Airbnb first: entire homes, guest favourites, inside a tight box around
// the neighbourhood the planner chose — so "central and walkable" holds.
async function airbnb(o) {
  const p = { engine: "airbnb", airbnb_domain: "airbnb.co.in", currency: "INR", q: o.city || "",
    check_in_date: o.checkin, check_out_date: o.checkout, adults: String(o.adults || 2), room_type: "entire_home", guest_favorite: "true" };
  if (o.lat && o.lng) { const d = 0.012, e = 0.016; p.map_bounds = [o.lat + d, o.lng + e, o.lat - d, o.lng - e].map(x => x.toFixed(5)).join(","); }
  let j = await serp(p);
  let list = j.organic_results || [];
  if (list.length < 3 && p.guest_favorite) { delete p.guest_favorite; j = await serp(p); list = j.organic_results || []; }
  const nights = Math.max(1, Math.round((new Date(o.checkout) - new Date(o.checkin)) / 864e5));
  return list.filter(r => r.extracted_price && (r.rating || 0) >= 4.6).slice(0, 5).map(r => ({
    id: r.listing_id, name: r.name || r.title, kind: r.title || "", link: r.link, rating: r.rating || null, reviews: r.reviews || 0,
    badges: r.badges || [], total: r.extracted_price, perNight: Math.round(r.extracted_price / nights),
    bedrooms: r.bedrooms || null, beds: r.beds || null, baths: r.bathrooms || null,
    freeCancel: !!r.free_cancellation, thumb: r.thumbnail || "", lat: r.gps_coordinates && r.gps_coordinates.latitude, lng: r.gps_coordinates && r.gps_coordinates.longitude
  }));
}
exports.airbnb = airbnb;

// ── fare watches ────────────────────────────────────────────────────────────
async function sendTelegram(text) {
  const base = process.env.URL || "https://rk-tracker-v2.netlify.app";
  try { await fetch(base + "/.netlify/functions/telegram", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "send", chatIds: ["8632288596"], message: text }) }); } catch (e) {}
}
async function runWatch(w) {
  const r = await flights(w.legs);
  const best = r.options.slice().sort((a, b) => a.price - b.price)[0];
  if (!best) return w;
  const prevLow = (w.history || []).reduce((m, h) => Math.min(m, h.price), Infinity);
  w.history = (w.history || []).concat([{ d: new Date().toISOString().slice(0, 10), price: best.price, airline: best.airlines }]).slice(-120);
  w.last = { price: best.price, airline: best.airlines, at: new Date().toISOString(), link: r.link };
  const hitTarget = w.target && best.price <= w.target;
  const newLow = isFinite(prevLow) && best.price < prevLow * 0.97;
  if (hitTarget || newLow) {
    const route = w.legs.map(l => l.from + "→" + l.to).join(", ");
    await sendTelegram("✈️ <b>Fare alert</b> · " + (w.label || route) + "\n₹" + best.price.toLocaleString("en-IN") + " per person · " + best.airlines +
      (hitTarget ? "\nBelow your target ₹" + Number(w.target).toLocaleString("en-IN") : "\nLowest seen so far") + (r.link ? "\n" + r.link : ""));
    w.alerted = new Date().toISOString();
  }
  return w;
}
exports.runAllWatches = async function () {
  const list = (await kvGet("fare_watches")) || [];
  const out = [];
  for (const w of list) {
    if (w.paused) { out.push(w); continue; }
    if (w.until && w.until < new Date().toISOString().slice(0, 10)) { out.push(Object.assign(w, { paused: true })); continue; }
    try { out.push(await runWatch(w)); } catch (e) { w.error = String(e.message || e); out.push(w); }
  }
  await kvSet("fare_watches", out);
  return out;
};

function driveId(url) {
  const m = String(url || "").match(/\/d\/([A-Za-z0-9_-]{10,})|[?&]id=([A-Za-z0-9_-]{10,})/);
  return m ? (m[1] || m[2]) : null;
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers: H, body: "" };
  let b = {}; try { b = JSON.parse(event.body || "{}"); } catch (e) { return OK({ error: "bad json" }); }
  try {
    switch (b.action) {
      case "profileGet": return OK({ ok: true, profile: await kvGet("travel_profile") });
      case "profileSave": await kvSet("travel_profile", b.profile || {}); return OK({ ok: true });

      case "planStart": {
        const job = genId();
        await kvSet("travel_job_" + job, { status: "working", at: new Date().toISOString() });
        const base = process.env.URL || "https://rk-tracker-v2.netlify.app";
        await fetch(base + "/.netlify/functions/travel-background", { method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ job, brief: String(b.brief || "").slice(0, 3000), profile: b.profile || {} }) });
        return OK({ ok: true, job });
      }
      case "transferStart": {
        const job = genId();
        await kvSet("travel_job_" + job, { status: "working", at: new Date().toISOString() });
        const base = process.env.URL || "https://rk-tracker-v2.netlify.app";
        await fetch(base + "/.netlify/functions/travel-background", { method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ job, mode: "transfers", q: b.q || {} }) });
        return OK({ ok: true, job });
      }
      case "planStatus": return OK({ ok: true, job: await kvGet("travel_job_" + b.job) });

      case "flights": return OK(Object.assign({ ok: true }, await flights(b.legs || [])));
      case "hotel": return OK(Object.assign({ ok: true }, await hotelPrice(b.name, b.city, b.checkin, b.checkout, b.adults)));
      case "airbnb": return OK({ ok: true, list: await airbnb(b) });

      case "watchList": return OK({ ok: true, watches: (await kvGet("fare_watches")) || [] });
      case "watchSave": {
        const list = (await kvGet("fare_watches")) || [];
        const w = Object.assign({ id: genId(), created: new Date().toISOString(), history: [] }, b.watch || {});
        const i = list.findIndex(x => x.id === w.id);
        if (i >= 0) list[i] = Object.assign(list[i], w); else list.push(w);
        let ran = w;
        if (b.runNow) { try { ran = await runWatch(i >= 0 ? list[i] : w); } catch (e) { ran.error = String(e.message || e); } }
        await kvSet("fare_watches", list.map(x => x.id === ran.id ? ran : x));
        return OK({ ok: true, watch: ran });
      }
      case "watchDelete": {
        const list = ((await kvGet("fare_watches")) || []).filter(x => x.id !== b.id);
        await kvSet("fare_watches", list); return OK({ ok: true });
      }

      case "reminder": {
        const e = { id: genId(), title: String(b.title || "Travel reminder").slice(0, 80), date: String(b.when || "").slice(0, 10),
          category: "Reminders", tags: ["Travel", "Pending"], notes: String(b.note || ""), reminder: b.when, reminderNote: String(b.note || b.title || ""),
          createdAt: new Date().toISOString() };
        const s = await call({ action: "save", user: "main", entry: e });
        if (s.ok) await smart.queueReminder(e, "main");
        return OK({ ok: !!s.ok });
      }

      case "fetchDoc": {
        const id = driveId(b.url);
        if (!id) return OK({ error: "not a Drive link" });
        const r = await fetch("https://drive.google.com/uc?export=download&id=" + id, { redirect: "follow" });
        const type = (r.headers.get("content-type") || "").split(";")[0];
        if (/text\/html/.test(type)) return OK({ error: "not shared" });
        const buf = Buffer.from(await r.arrayBuffer());
        if (buf.length > 5500000) return OK({ error: "too large" });
        return OK({ ok: true, type, b64: buf.toString("base64") });
      }
    }
    return OK({ error: "unknown action" });
  } catch (e) {
    return OK({ error: e.code === "nokey" ? "nokey" : String(e.message || e) });
  }
};
