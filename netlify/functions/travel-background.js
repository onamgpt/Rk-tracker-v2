// AI trip planner (background: up to 15 min). Writes the finished plan to
// kv "travel_job_<id>"; the Travel Desk polls for it.
const https = require("https");
const db = require("./db.js");
const travel = require("./travel.js");
const call = async (b) => JSON.parse((await db.handler({ httpMethod: "POST", body: JSON.stringify(b) })).body || "{}");
const kvSet = (key, data) => call({ action: "savePortfolio", user: "main", key, data });

// The plan is returned through a forced tool call, so the API hands back an
// already-parsed object — free text JSON broke on a stray quote or comma.
const PLAN_TOOL = { name: "save_plan", description: "Save the finished trip plan.",
  input_schema: { type: "object", properties: {
    name: { type: "string" }, start: { type: "string" }, pax: { type: "number" }, homeCity: { type: "string" }, homeAirport: { type: "string" },
    summary: { type: "string" }, sectors: { type: "array", items: { type: "object" } }, flights: { type: "array", items: { type: "object" } },
    flightAdvice: { type: "string" }, hotels: { type: "array", items: { type: "object" } }, days: { type: "array", items: { type: "object" } },
    budget: { type: "array", items: { type: "object" } }, docs: { type: "array", items: { type: "object" } }, fx: { type: "object" } },
    required: ["name", "start", "pax", "sectors", "flights", "hotels", "days", "budget"] } };

function ask(model, system, prompt, maxTokens) {
  const body = JSON.stringify({ model, max_tokens: maxTokens, system, messages: [{ role: "user", content: prompt }],
    tools: [PLAN_TOOL], tool_choice: { type: "tool", name: "save_plan" } });
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname: "api.anthropic.com", path: "/v1/messages", method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": process.env.ANTHROPIC_API_KEY || "", "anthropic-version": "2023-06-01", "Content-Length": Buffer.byteLength(body) } },
      res => { let d = ""; res.on("data", c => d += c); res.on("end", () => { try { const j = JSON.parse(d); if (j.error) return reject(new Error(j.error.message)); const tu = (j.content || []).find(x => x.type === "tool_use");
          if (tu && tu.input && typeof tu.input === "object") return resolve(tu.input);
          resolve((j.content || []).map(x => x.text || "").join("")); } catch (e) { reject(e); } }); });
    req.on("error", reject); req.setTimeout(240000, () => { req.destroy(); reject(new Error("timeout")); });
    req.write(body); req.end();
  });
}
function parse(t) {
  if (t && typeof t === "object") return t;
  const s = String(t || "").replace(/```json|```/g, "");
  return JSON.parse(s.slice(s.indexOf("{"), s.lastIndexOf("}") + 1));
}

const SYSTEM = "You are an expert family travel planner for an Indian family based in Bangalore. You know real hotels, real airports (IATA codes), real attractions, visa rules for Indian passport holders, and realistic 2026-27 prices. Save the plan with the save_plan tool.";

function prompt(brief, profile) {
  const today = new Date().toISOString().slice(0, 10);
  return `Today: ${today}
Brief: """${brief}"""
Travellers and rules (follow strictly): ${JSON.stringify(profile || {})}

Plan the trip. Rules of thumb: gentle pace, one main thing per day; hotels 4-star, central, on flat ground, walkable to sights; compare hotels on TOTAL cost including taxis; avoid routings that need extra transit visas for Indian passports; keep flights short; vegetarian food notes. Give 3 real hotel options per stay (mark one "pick": true), and flag any option that breaks a rule. Prices are estimates.

Call save_plan with exactly this shape:
{"name":"trip name","start":"YYYY-MM-DD (departure day from home)","pax":number,"homeCity":"Bengaluru","homeAirport":"BLR",
"summary":"2 sentences",
"sectors":[{"city":"","nights":n,"mode":"flight|train|car|bus|ferry","airport":"IATA or empty"}],
"flights":[{"from":"IATA","to":"IATA","date":"YYYY-MM-DD","label":"e.g. Bangalore → Auckland","international":true}],
"flightAdvice":"which airline/route to prefer and why; routes to avoid",
"hotels":[{"sector":index,"options":[{"name":"","area":"","stars":4,"perNight":number,"currency":"NZD","pick":true,"why":"","flag":""}]}],
"days":[{"date":"YYYY-MM-DD","items":[{"type":"flight|train|hotel|taxi|activity|other","time":"HH:MM or empty","title":"","note":""}]}],
"budget":[{"item":"","inr":number}],
"docs":[{"title":"","due":"YYYY-MM-DD","note":""}],
"fx":{"currency":"NZD","inr":51}}
The nights of all sectors must add up to the trip length; days must cover start date to the day you land home. Budget in INR for all travellers together.`;
}

exports.handler = async (event) => {
  let b = {}; try { b = JSON.parse(event.body || "{}"); } catch (e) { return; }
  if (!b.job) return;
  const key = "travel_job_" + b.job;
  try {
    let plan = null, lastErr = null;
    for (const model of ["claude-sonnet-5-5", "claude-sonnet-5-5", "claude-haiku-4-5-20251001"]) {
      try { plan = parse(await ask(model, SYSTEM, prompt(b.brief, b.profile), 12000)); if (plan && plan.sectors) break; }
      catch (e) { lastErr = e; plan = null; }
    }
    if (!plan) throw lastErr || new Error("planner returned nothing");

    // Live prices where possible (a handful of SerpApi searches per plan).
    plan.live = { checked: new Date().toISOString() };
    if (process.env.SERPAPI_KEY) {
      const intl = (plan.flights || []).filter(f => f.international);
      try { if (intl.length) plan.live.flights = await travel_flights(intl); } catch (e) { plan.live.flightsError = String(e.message || e); }
      // nightly price for each picked hotel
      const starts = []; let cur = plan.start;
      // sector arrival dates: flights overnight are handled by the client; use start + cumulative nights (+1 for long-haul arrival)
      (plan.sectors || []).forEach((s, i) => { starts.push(cur); cur = addDays(cur, Number(s.nights) || 0); });
      plan.live.hotels = {};
      for (const h of plan.hotels || []) {
        const pick = (h.options || []).find(o => o.pick) || (h.options || [])[0];
        const s = (plan.sectors || [])[h.sector];
        if (!pick || !s) continue;
        const ci = hotelCheckin(plan, h.sector), co = addDays(ci, Number(s.nights) || 1);
        try { plan.live.hotels[h.sector] = await travel_hotel(pick.name, s.city, ci, co, plan.pax || 2); } catch (e) {}
      }
    }
    await kvSet(key, { status: "done", plan, brief: b.brief, at: new Date().toISOString() });
  } catch (e) {
    await kvSet(key, { status: "error", error: String(e.message || e) });
  }
};

function addDays(iso, n) { const d = new Date(iso + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
// The first stay starts on the day the outbound flight lands; later stays follow on.
function hotelCheckin(plan, idx) {
  const firstHotelDay = (plan.days || []).find(d => (d.items || []).some(i => i.type === "hotel"));
  let cur = firstHotelDay ? firstHotelDay.date : plan.start;
  for (let i = 0; i < idx; i++) cur = addDays(cur, Number(plan.sectors[i].nights) || 0);
  return cur;
}
exports.hotelCheckin = hotelCheckin;

// small wrappers around travel.js internals via its handler
async function travel_flights(legs) {
  const r = JSON.parse((await travel.handler({ httpMethod: "POST", body: JSON.stringify({ action: "flights", legs }) })).body);
  if (r.error) throw new Error(r.error); return r;
}
async function travel_hotel(name, city, checkin, checkout, adults) {
  const r = JSON.parse((await travel.handler({ httpMethod: "POST", body: JSON.stringify({ action: "hotel", name, city, checkin, checkout, adults }) })).body);
  if (r.error) throw new Error(r.error); return r;
}
