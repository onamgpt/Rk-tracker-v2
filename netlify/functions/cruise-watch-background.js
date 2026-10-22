// Cruise Deals Watch — background worker (up to 15 min).
// Searches each cruise line's own website (Anthropic web search restricted to that
// line's domain) for Europe sailings of 9 nights or less, any date, priced at or
// under $1,000 per person. Compares with the previous run and emails the owner.
// Triggered by cruise-cron.js (every 15 days) or the "Run now" button on /cruise/.
const https = require("https");

const MAX_PRICE = 1000;   // USD per person
const MAX_NIGHTS = 9;
const OWNER = "onamagarbathi@gmail.com";
const REGIONS = {
  europe: {
    key: "cruise_watch", title: "Europe", tab: "Cruises",
    where: "EUROPE (Mediterranean, Northern Europe, Baltic, Norway, British Isles, Atlantic Europe)",
    perLine: "",
    lines: [
      { name: "Royal Caribbean", domain: "royalcaribbean.com" },
      { name: "MSC Cruises", domain: "msccruises.com" },
      { name: "Costa Cruises", domain: "costacruises.com" },
      { name: "Celebrity Cruises", domain: "celebritycruises.com" },
      { name: "Norwegian Cruise Line", domain: "ncl.com" }
    ]
  },
  sea: {
    key: "cruise_watch_sea", title: "Southeast Asia", tab: "SE Asia Cruises",
    where: "SOUTHEAST ASIA, sailing from a Southeast Asian port such as Singapore, Bangkok (Laem Chabang), Phuket, Port Klang or Penang (Malaysia), Ho Chi Minh City (Phu My), Jakarta, Bali, Manila, or Sihanoukville, so he can simply fly there and board",
    perLine: " List at most the 8 best-value sailings per line.",
    lines: [
      { name: "Royal Caribbean", domain: "royalcaribbean.com" },
      { name: "Resorts World Cruises", domain: "rwcruises.com" },
      { name: "Costa Cruises", domain: "costacruises.com" },
      { name: "Princess Cruises", domain: "princess.com" },
      { name: "Norwegian Cruise Line", domain: "ncl.com" }
    ]
  }
};
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

const AGG = ["cruisebound.com", "cruiseweb.com", "cruisewatch.com", "affordabletours.com", "taoticket.com", "globaljourneys.com"];

async function searchLine(line, R) {
  const today = new Date().toISOString().slice(0, 10);
  const prompt =
    "Today is " + today + ". Find current " + line.name + " cruises in " + R.where + " that are " +
    MAX_NIGHTS + " nights or shorter, any sailing date from now on, with a published lowest fare of USD " + MAX_PRICE +
    " or less PER PERSON (cheapest cabin, 2 sharing). Use the cruise line's own site (" + line.domain + ") first, then the agent/aggregator sites you are allowed to search for prices the line's site does not show.\n" +
    "Rules:" + R.perLine + " only include a sailing if a page you read shows its price; never guess. For every deal give the DIRECT link to the exact page where you saw that sailing and price (not a homepage). " +
    "Always include the departure country in departure_port. Capture everything useful for a fast decision: ship, route and main ports, departure port, start date, nights, price per person, cabin type, whether taxes and port fees are included, " +
    "and any inclusions or promotions shown (free drinks or beverage package, free Wi-Fi, onboard credit, free gratuities, free shore excursion credit, kids sail free, free hotel night, free breakfast, flights included, etc.).\n" +
    "Reply with ONLY JSON: {\"deals\":[{\"ship\":\"\",\"itinerary\":\"\",\"ports\":\"\",\"departure_port\":\"\",\"start_date\":\"YYYY-MM-DD\",\"nights\":0," +
    "\"price_usd_pp\":0,\"cabin\":\"\",\"taxes_included\":null,\"inclusions\":[\"\"],\"offer\":\"\",\"url\":\"\",\"source\":\"\"}],\"cheapest_seen_usd_pp\":null,\"note\":\"\"}. " +
    "Use an empty deals array if none qualify, and put the cheapest Europe fare you did see (any length) in cheapest_seen_usd_pp.";
  let messages = [{ role: "user", content: prompt }];
  for (let i = 0; i < 6; i++) {
    const r = await anthropic({
      model: "claude-sonnet-4-6", max_tokens: 6000, messages,
      tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 10, allowed_domains: [line.domain].concat(AGG) }]
    });
    if (r.error) return { line: line.name, error: r.error.message || "API error", deals: [] };
    if (r.stop_reason === "pause_turn") { messages = messages.concat({ role: "assistant", content: r.content }); continue; }
    const text = (r.content || []).filter(c => c.type === "text").map(c => c.text).join("\n");
    const j = parseJson(text);
    if (!j) return { line: line.name, error: "could not read result", deals: [] };
    const deals = (j.deals || []).filter(d => d && Number(d.price_usd_pp) > 0 && Number(d.price_usd_pp) <= MAX_PRICE && Number(d.nights) > 0 && Number(d.nights) <= MAX_NIGHTS)
      .map(d => {
        const price = Number(d.price_usd_pp), nights = Number(d.nights);
        return Object.assign({ line: line.name }, d, { price_usd_pp: price, nights, per_night: Math.round(price / nights),
          inclusions: Array.isArray(d.inclusions) ? d.inclusions.filter(Boolean) : [] });
      });
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

function emailHtml(results, all, prevMap, R) {
  let rows = "";
  all.sort((a, b) => a.price_usd_pp - b.price_usd_pp).forEach(d => {
    const p = prevMap[dealKey(d)];
    const chg = p == null ? "<b style='color:#0a7d2c'>NEW</b>" : (d.price_usd_pp > p ? "<span style='color:#c0392b'>&#9650; $" + (d.price_usd_pp - p) + "</span>" : d.price_usd_pp < p ? "<span style='color:#0a7d2c'>&#9660; $" + (p - d.price_usd_pp) + "</span>" : "same");
    const inc = (d.inclusions || []).map(esc).join(", ") + (d.offer ? (d.inclusions && d.inclusions.length ? "<br>" : "") + "<i>" + esc(d.offer) + "</i>" : "");
    const tax = d.taxes_included === true ? "taxes incl." : d.taxes_included === false ? "+ taxes/fees" : "taxes: check";
    rows += "<tr style='vertical-align:top'><td><b>" + esc(d.ship) + "</b><br><small>" + esc(d.line) + "</small></td>" +
      "<td>" + esc(d.itinerary) + "<br><small>" + esc(d.ports) + "<br>from " + esc(d.departure_port) + "</small></td>" +
      "<td>" + esc(d.start_date) + "<br>" + d.nights + " nights</td>" +
      "<td><b>$" + d.price_usd_pp + "</b><br><small>$" + d.per_night + "/night<br>" + esc(d.cabin || "") + "<br>" + tax + "</small></td>" +
      "<td><small>" + (inc || "&mdash;") + "</small></td><td>" + chg + "</td>" +
      "<td>" + (d.url ? "<a href='" + esc(d.url) + "'>Open</a>" + (d.source ? "<br><small>" + esc(d.source) + "</small>" : "") : "") + "</td></tr>";
  });
  const status = results.map(r => "<li>" + esc(r.line) + ": " + (r.error ? "<span style='color:#c0392b'>could not read (" + esc(r.error) + ")</span>" : r.deals.length + " deal" + (r.deals.length === 1 ? "" : "s") + (!r.deals.length && r.cheapest ? " &mdash; cheapest Europe fare seen $" + esc(r.cheapest) : "")) + "</li>").join("");
  return "<div style='font-family:Arial,sans-serif;max-width:900px'><h2 style='margin:0 0 6px'>Cruise deals &mdash; Europe, up to $" + MAX_PRICE + " per person</h2>" +
    "<p style='margin:0 0 10px;color:#555'>" + MAX_NIGHTS + " nights or fewer, any date, cheapest cabin, 2 sharing. Fares rise as sailings fill. Prices are as shown on the linked page today; check it before booking.</p>" +
    (rows ? "<table cellpadding='6' style='border-collapse:collapse;width:100%;font-size:13px' border='1' bordercolor='#ddd'><tr style='background:#f4f4f4'><th>Ship</th><th>Route / ports</th><th>Sails</th><th>Price pp</th><th>Included / offers</th><th>Change</th><th>Link</th></tr>" + rows + "</table>" : "<p><b>No sailings at or under $" + MAX_PRICE + " found this time.</b></p>") +
    "<p style='margin-top:14px'><b>Per cruise line</b></p><ul>" + status + "</ul>" +
    "<p style='color:#777;font-size:12px'>Next check in 15 days. Full sortable table: https://rk-tracker-v2.netlify.app/travel/ (" + R.tab + " tab)</p></div>";
}

exports.handler = async (event) => {
  if (!process.env.ANTHROPIC_API_KEY) return { statusCode: 200, body: "no key" };
  let b = {}; try { b = JSON.parse((event && event.body) || "{}"); } catch (e) {}
  const R = REGIONS[b.region] || REGIONS.europe;
  const KEY = R.key;
  const prev = ((await dbCall({ action: "getPortfolio", user: "main", key: KEY })).data) || {};
  await dbCall({ action: "savePortfolio", user: "main", key: KEY, data: Object.assign({}, prev, { running_since: new Date().toISOString() }) });
  const results = [];
  for (const line of R.lines) results.push(await searchLine(line, R));
  const all = [].concat.apply([], results.map(r => r.deals));
  const prevMap = {};
  (prev.deals || []).forEach(d => { prevMap[dealKey(d)] = d.price_usd_pp; });
  const data = { last_run: new Date().toISOString(), deals: all, lines: results.map(r => ({ line: r.line, count: r.deals.length, error: r.error || null, cheapest: r.cheapest || null })) };
  await dbCall({ action: "savePortfolio", user: "main", key: KEY, data });
  try {
    const mail = require("./mail.js");
    await mail.handler({ httpMethod: "POST", body: JSON.stringify({ to: OWNER,
      subject: "Cruise deals " + R.title + " \u2264 $" + MAX_PRICE + " pp \u2014 " + all.length + " found",
      html: emailHtml(results, all.slice(), prevMap, R) }) });
  } catch (e) {}
  return { statusCode: 200, body: "done" };
};
