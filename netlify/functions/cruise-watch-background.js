// Cruise Deals Watch — background worker (up to 15 min).
// Searches each cruise line's own website (Anthropic web search restricted to that
// line's domain) for Europe sailings of 9 nights or less, any date, priced at or
// under $1,000 per person. Compares with the previous run and emails the owner.
// Triggered by cruise-cron.js (every 15 days) or the "Run now" button on /cruise/.
const https = require("https");

const MAX_PRICE = 1000;   // USD per person
const MAX_NIGHTS = 9;
const OWNER = "onamagarbathi@gmail.com";
const KEY = "cruise_watch";
const LINES = [
  { name: "Royal Caribbean", domain: "royalcaribbean.com" },
  { name: "MSC Cruises", domain: "msccruises.com" },
  { name: "Costa Cruises", domain: "costacruises.com" },
  { name: "Celebrity Cruises", domain: "celebritycruises.com" },
  { name: "Norwegian Cruise Line", domain: "ncl.com" }
];

function anthropic(body) {
  const payload = JSON.stringify(body);
  return new Promise((resolve) => {
    const req = https.request({
      hostname: "api.anthropic.com", path: "/v1/messages", method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01", "Content-Length": Buffer.byteLength(payload) }
    }, (res) => {
      let d = ""; res.on("data", c => d += c);
      res.on("end", () => { try { resolve(JSON.parse(d)); } catch (e) { resolve({ error: { message: "bad json" } }); } });
    });
    req.on("error", e => resolve({ error: { message: String(e) } }));
    req.setTimeout(170000, () => { req.destroy(); resolve({ error: { message: "timeout" } }); });
    req.write(payload); req.end();
  });
}

function parseJson(text) {
  const a = text.indexOf("{"), b = text.lastIndexOf("}");
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(text.slice(a, b + 1)); } catch (e) { return null; }
}

async function searchLine(line) {
  const today = new Date().toISOString().slice(0, 10);
  const prompt =
    "Today is " + today + ". Using web search on " + line.domain + " pages only, find current " + line.name +
    " cruises in EUROPE (Mediterranean, Northern Europe, Baltic, Norway fjords, British Isles, Atlantic Europe) that are " +
    MAX_NIGHTS + " nights or shorter, any sailing date from now on, with a published lowest fare of USD " + MAX_PRICE +
    " or less PER PERSON (cheapest cabin, 2 sharing, as shown on the site). Check the line's deals, offers and Europe cruise pages.\n" +
    "Only include a sailing if the page you read actually shows its price. Never guess prices.\n" +
    "Reply with ONLY JSON: {\"deals\":[{\"ship\":\"\",\"itinerary\":\"\",\"departure_port\":\"\",\"start_date\":\"YYYY-MM-DD\",\"nights\":0," +
    "\"price_usd_pp\":0,\"cabin\":\"\",\"url\":\"\"}],\"cheapest_seen_usd_pp\":null,\"note\":\"\"}. " +
    "Use an empty deals array if none qualify, and put the cheapest Europe fare you did see (any length) in cheapest_seen_usd_pp.";
  let messages = [{ role: "user", content: prompt }];
  for (let i = 0; i < 5; i++) {
    const r = await anthropic({
      model: "claude-sonnet-4-6", max_tokens: 4000, messages,
      tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 8, allowed_domains: [line.domain] }]
    });
    if (r.error) return { line: line.name, error: r.error.message || "API error", deals: [] };
    if (r.stop_reason === "pause_turn") { messages = messages.concat({ role: "assistant", content: r.content }); continue; }
    const text = (r.content || []).filter(c => c.type === "text").map(c => c.text).join("\n");
    const j = parseJson(text);
    if (!j) return { line: line.name, error: "could not read result", deals: [] };
    const deals = (j.deals || []).filter(d => d && Number(d.price_usd_pp) > 0 && Number(d.price_usd_pp) <= MAX_PRICE && Number(d.nights) > 0 && Number(d.nights) <= MAX_NIGHTS)
      .map(d => Object.assign({ line: line.name }, d, { price_usd_pp: Number(d.price_usd_pp), nights: Number(d.nights) }));
    return { line: line.name, deals, cheapest: j.cheapest_seen_usd_pp || null, note: j.note || "" };
  }
  return { line: line.name, error: "search did not finish", deals: [] };
}

async function dbCall(b) {
  const db = require("./db.js");
  return JSON.parse((await db.handler({ httpMethod: "POST", body: JSON.stringify(b) })).body || "{}");
}
const dealKey = d => [d.line, d.ship, d.start_date, d.nights].join("|").toLowerCase();
const esc = s => String(s == null ? "" : s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

function emailHtml(results, all, prevMap) {
  let rows = "";
  all.sort((a, b) => a.price_usd_pp - b.price_usd_pp).forEach(d => {
    const p = prevMap[dealKey(d)];
    const chg = p == null ? "<b style='color:#0a7d2c'>NEW</b>" : (d.price_usd_pp > p ? "<span style='color:#c0392b'>▲ $" + (d.price_usd_pp - p) + "</span>" : d.price_usd_pp < p ? "<span style='color:#0a7d2c'>▼ $" + (p - d.price_usd_pp) + "</span>" : "same");
    rows += "<tr><td>" + esc(d.line) + "</td><td>" + esc(d.ship) + "<br><small>" + esc(d.itinerary) + " · from " + esc(d.departure_port) + "</small></td><td>" + esc(d.start_date) + "<br>" + d.nights + " nights</td><td><b>$" + d.price_usd_pp + "</b><br><small>" + esc(d.cabin || "per person") + "</small></td><td>" + chg + "</td><td>" + (d.url ? "<a href='" + esc(d.url) + "'>Book</a>" : "") + "</td></tr>";
  });
  const status = results.map(r => "<li>" + esc(r.line) + ": " + (r.error ? "<span style='color:#c0392b'>could not read (" + esc(r.error) + ")</span>" : r.deals.length + " deal" + (r.deals.length === 1 ? "" : "s") + (!r.deals.length && r.cheapest ? " — cheapest Europe fare seen $" + esc(r.cheapest) : "")) + "</li>").join("");
  return "<div style='font-family:Arial,sans-serif;max-width:720px'><h2 style='margin:0 0 6px'>Cruise deals — Europe, up to $" + MAX_PRICE + " per person</h2>" +
    "<p style='margin:0 0 10px;color:#555'>" + MAX_NIGHTS + " nights or fewer, any date. Fares rise as sailings fill, so earlier is usually cheaper. Prices are as shown on each site today; check the page before booking.</p>" +
    (rows ? "<table cellpadding='6' style='border-collapse:collapse;width:100%;font-size:14px' border='1' bordercolor='#ddd'><tr style='background:#f4f4f4'><th>Line</th><th>Ship / route</th><th>Sails</th><th>Price</th><th>Change</th><th></th></tr>" + rows + "</table>" : "<p><b>No sailings at or under $" + MAX_PRICE + " found this time.</b></p>") +
    "<p style='margin-top:14px'><b>Per cruise line</b></p><ul>" + status + "</ul>" +
    "<p style='color:#777;font-size:12px'>Next check in 15 days. Full list: https://rk-tracker-v2.netlify.app/travel/ (Cruises tab)</p></div>";
}

exports.handler = async () => {
  if (!process.env.ANTHROPIC_API_KEY) return { statusCode: 200, body: "no key" };
  const prev = ((await dbCall({ action: "getPortfolio", user: "main", key: KEY })).data) || {};
  await dbCall({ action: "savePortfolio", user: "main", key: KEY, data: Object.assign({}, prev, { running_since: new Date().toISOString() }) });
  const results = [];
  for (const line of LINES) results.push(await searchLine(line));
  const all = [].concat.apply([], results.map(r => r.deals));
  const prevMap = {};
  (prev.deals || []).forEach(d => { prevMap[dealKey(d)] = d.price_usd_pp; });
  const data = { last_run: new Date().toISOString(), deals: all, lines: results.map(r => ({ line: r.line, count: r.deals.length, error: r.error || null, cheapest: r.cheapest || null })) };
  await dbCall({ action: "savePortfolio", user: "main", key: KEY, data });
  try {
    const mail = require("./mail.js");
    await mail.handler({ httpMethod: "POST", body: JSON.stringify({ to: OWNER,
      subject: "Cruise deals ≤ $" + MAX_PRICE + " pp, Europe — " + all.length + " found",
      html: emailHtml(results, all.slice(), prevMap) }) });
  } catch (e) {}
  return { statusCode: 200, body: "done" };
};
