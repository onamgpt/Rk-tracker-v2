// Team Locations: per-person location files, filled from salespeople's
// location emails (map links). Road distance from Google (via distance.js),
// place name from OpenStreetMap. Allowance is counted once per day
// (highest band that day) when monthly totals are worked out.
const db = require("./db.js");
const G = require("./gmail.js");
const call = async (b) => JSON.parse((await db.handler({ httpMethod: "POST", body: JSON.stringify(b) })).body || "{}");
const kvGet = async (k) => { const r = await call({ action: "getPortfolio", user: "main", key: k }); return r && r.data != null ? r.data : null; };
const kvSet = (k, d) => call({ action: "savePortfolio", user: "main", key: k, data: d });

// Same team, HQs and daily rates as the tracker's Sales config.
const PEOPLE = {
  "sunilkumar839839@gmail.com": { name: "Sunil", hq: "Calicut", hqLat: 11.2588, hqLng: 75.7804, allowance: { HQ: 245, "Ex-HQ": 335, Outstation: 515 } },
  "onamsada@gmail.com": { name: "Sadasivan", hq: "Coimbatore", hqLat: 11.0168, hqLng: 76.9558, allowance: { HQ: 230, "Ex-HQ": 305, Outstation: 470 } },
  "sebijosephc3@gmail.com": { name: "Sebi", hq: "Trissur", hqLat: 10.5276, hqLng: 76.2144, allowance: { HQ: 190, "Ex-HQ": 285, Outstation: 445 } },
  "bijumeenadom@gmail.com": { name: "Biju", hq: "Kottayam", hqLat: 9.5916, hqLng: 76.5222, allowance: { HQ: 240, "Ex-HQ": 385, Outstation: 590 } },
  "sathisonam61@gmail.com": { name: "Satish", hq: "Calicut", hqLat: 11.2588, hqLng: 75.7804, allowance: { HQ: 370, "Ex-HQ": 790, Outstation: 1625 } },
  "onamvinod@gmail.com": { name: "Vinod", hq: "Cherthala", hqLat: 9.717843, hqLng: 76.323059, allowance: { HQ: 220, "Ex-HQ": 330, Outstation: 445 } },
  "soorajnandana892@gmail.com": { name: "Sooraj", hq: "Trivandrum", hqLat: 8.5241, hqLng: 76.9366, allowance: { HQ: 195, "Ex-HQ": 295, Outstation: 420 } }
};
const BANDS = [{ label: "HQ", maxKm: 100 }, { label: "Ex-HQ", maxKm: 300 }, { label: "Outstation", maxKm: 1e9 }];
const band = (km) => BANDS.find((b) => km <= b.maxKm).label;
const byName = (n) => Object.values(PEOPLE).find((p) => p.name.toLowerCase() === String(n || "").toLowerCase());

function coordsIn(text) {
  if (!text) return null;
  const pats = [/!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/, /@(-?\d+\.\d+),(-?\d+\.\d+)/, /[?&]q=(-?\d+\.\d+)(?:,|%2C)(-?\d+\.\d+)/, /[?&]ll=(-?\d+\.\d+),(-?\d+\.\d+)/,
    /[?&](?:center|destination|query)=(-?\d+\.\d+)(?:,|%2C)(-?\d+\.\d+)/, /\/(-?\d+\.\d{4,}),(-?\d+\.\d{4,})/, /(-?\d{1,2}\.\d{5,})\s*,\s*(-?\d{2,3}\.\d{5,})/];
  for (const p of pats) { const m = String(text).match(p); if (m) { const lat = +m[1], lng = +m[2]; if (Math.abs(lat) <= 90 && Math.abs(lng) <= 180) return { lat, lng }; } }
  return null;
}
const MAPLINK = /https?:\/\/(?:maps\.app\.goo\.gl|goo\.gl\/maps|goo\.gl|maps\.google\.[a-z.]+|www\.google\.[a-z.]+\/maps|google\.[a-z.]+\/maps)\/?[A-Za-z0-9_\/?=&.%@,+!:-]*/;
async function expand(url) {
  try { const r = await require("./expand.js").handler({ httpMethod: "GET", queryStringParameters: { url } }); const j = JSON.parse(r.body || "{}");
    if (j.coords && typeof j.coords.lat === "number") return j.coords; return coordsIn(j.finalUrl || ""); } catch (e) { return null; }
}
async function roadKm(p, c) {
  try { const r = await require("./distance.js").handler({ httpMethod: "POST", body: JSON.stringify({ origin: p.hqLat + "," + p.hqLng, destination: c.lat + "," + c.lng }) });
    const j = JSON.parse(r.body || "{}"); if (j.ok && typeof j.km === "number") return { km: j.km, min: j.durationMin || null, exact: true }; } catch (e) {}
  const R = 6371, dLat = (c.lat - p.hqLat) * Math.PI / 180, dLng = (c.lng - p.hqLng) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(p.hqLat * Math.PI / 180) * Math.cos(c.lat * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
  return { km: Math.round(R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)) * 1.2 * 10) / 10, min: null, exact: false };
}
let lastOSM = 0;
async function placeName(c) {
  try {
    const wait = 1100 - (Date.now() - lastOSM); if (wait > 0) await new Promise((r) => setTimeout(r, wait)); lastOSM = Date.now();
    const r = await fetch("https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=14&lat=" + c.lat + "&lon=" + c.lng, { headers: { "User-Agent": "RK-Tracker/1.0 (onamagarbathi@gmail.com)", "Accept-Language": "en" } });
    const j = await r.json(); const a = j.address || {};
    return [a.village || a.suburb || a.town || a.city_district || a.city || a.hamlet, a.county || a.state_district].filter(Boolean).slice(0, 2).join(", ") || (j.display_name || "").split(",").slice(0, 2).join(",");
  } catch (e) { return ""; }
}
const istDate = (ms) => new Date((ms || Date.now()) + 5.5 * 3600e3).toISOString().slice(0, 10);
const istTime = (ms) => new Date((ms || Date.now()) + 5.5 * 3600e3).toISOString().slice(11, 16);
const fileKey = (name) => "loc_" + String(name).toLowerCase();

async function loadFile(name) { return (await kvGet(fileKey(name))) || []; }
async function saveFile(name, list) { list.sort((a, z) => (a.date + a.time < z.date + z.time ? -1 : 1)); await kvSet(fileKey(name), list); }

// Build a visit record from a coordinate for a person
async function makeVisit(p, c, extra) {
  const rk = await roadKm(p, c);
  return Object.assign({ id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), lat: c.lat, lng: c.lng,
    km: rk.km, min: rk.min, exact: rk.exact, band: band(rk.km), place: await placeName(c) }, extra);
}

// Read new location emails from Gmail into the per-person files
async function importLocationEmails(days) {
  const seen = (await kvGet("loc_mail_seen")) || [];
  const froms = Object.keys(PEOPLE).join(" OR ");
  const { messages } = await G.search("(from:(" + froms + ") OR subject:location) newer_than:" + (days || 4) + "d", 40);
  const added = [], skipped = [];
  const files = {};
  for (const m of messages.reverse()) {
    if (seen.includes(m.id)) continue;
    const addr = (String(m.from).match(/<([^>]+)>/) || [, m.from])[1].trim().toLowerCase();
    const p = PEOPLE[addr];
    const text = m.subject + "\n" + m.body;
    let c = coordsIn(text);
    const link = (text.match(MAPLINK) || [""])[0];
    if (!c && link) c = await expand(link);
    seen.push(m.id);
    if (!p) { skipped.push((m.from || "?") + " — not a team member"); continue; }
    if (!c) { skipped.push(p.name + " — no map location in “" + String(m.subject).slice(0, 40) + "”"); continue; }
    const v = await makeVisit(p, c, { date: istDate(m.internalDate), time: istTime(m.internalDate), mapLink: link, gmailId: m.id, subject: String(m.subject).slice(0, 120), source: "email" });
    const f = files[p.name] || (files[p.name] = await loadFile(p.name));
    if (!f.some((x) => x.gmailId === m.id)) { f.push(v); added.push(p.name + " · " + v.date + " · " + (v.place || (c.lat + "," + c.lng)) + " · " + Math.round(v.km) + " km " + (v.exact ? "by road" : "(est.)")); }
  }
  for (const n in files) await saveFile(n, files[n]);
  await kvSet("loc_mail_seen", seen.slice(-1500));
  return { added, skipped };
}

// Copy old location entries out of the main tracker into the files
async function migrateFromTracker() {
  const r = await call({ action: "getAll", user: "main" });
  const old = (r.entries || []).filter((e) => /Location:\s*-?\d/.test(e.notes || "") && /\[gmailId:/.test(e.notes || "") && /travel/i.test((e.tags || []).join(" ") + " " + (e.category || "")));
  const files = {}, copied = [], ids = [];
  for (const e of old) {
    const p = byName(e.person); const mm = e.notes.match(/Location:\s*(-?\d+\.\d+)\s*,\s*(-?\d+\.\d+)/); const c = mm ? { lat: +mm[1], lng: +mm[2] } : null;
    const gid = (e.notes.match(/gmailId:([^\]\s]+)/) || [])[1] || "";
    if (!p || !c) continue;
    const f = files[p.name] || (files[p.name] = await loadFile(p.name));
    ids.push(e.id);
    if (f.some((x) => (gid && x.gmailId === gid) || x.trackerId === e.id)) continue;
    f.push(await makeVisit(p, c, { date: String(e.date || "").slice(0, 10), time: "", mapLink: "", gmailId: gid, subject: e.title || "", source: "tracker", trackerId: e.id }));
    copied.push(p.name + " · " + e.date);
  }
  for (const n in files) await saveFile(n, files[n]);
  await kvSet("loc_migration", { at: new Date().toISOString(), found: old.length, copied: copied.length, trackerIds: ids, removed: false });
  return { found: old.length, copied: copied.length };
}

// After Ravi has checked: remove those old entries from the main tracker
async function removeMigrated() {
  const m = (await kvGet("loc_migration")) || {};
  const ids = m.trackerIds || []; let removed = 0;
  const SB = (process.env.SUPABASE_URL || "").replace(/\/$/, ""), KEY = process.env.SUPABASE_SERVICE_KEY || "";
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50).map((x) => '"' + String(x).replace(/"/g, "") + '"').join(",");
    const r = await fetch(SB + "/rest/v1/entries?id=in.(" + encodeURIComponent(chunk) + ")", { method: "DELETE", headers: { apikey: KEY, Authorization: "Bearer " + KEY, Prefer: "return=minimal" } });
    if (r.ok) removed += Math.min(50, ids.length - i);
  }
  m.removed = true; m.removedAt = new Date().toISOString(); m.removedCount = removed;
  await kvSet("loc_migration", m);
  return { removed };
}
module.exports = { PEOPLE, BANDS, kvGet, kvSet, loadFile, saveFile, importLocationEmails, migrateFromTracker, removeMigrated, fileKey };
