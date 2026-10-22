// Read the latest cruise scan, or start one now (for the /cruise/ page).
const H = { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json", "Access-Control-Allow-Headers": "Content-Type", "Access-Control-Allow-Methods": "POST, GET, OPTIONS" };
exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers: H, body: "" };
  let b = {}; try { b = JSON.parse(event.body || "{}"); } catch (e) {}
  const db = require("./db.js");
  const call = async (x) => JSON.parse((await db.handler({ httpMethod: "POST", body: JSON.stringify(x) })).body || "{}");
  const cur = (await call({ action: "getPortfolio", user: "main", key: "cruise_watch" })).data || {};
  if (b.action === "run") {
    const busy = cur.running_since && (!cur.last_run || cur.running_since > cur.last_run) && Date.now() - new Date(cur.running_since).getTime() < 20 * 60000;
    if (busy) return { statusCode: 200, headers: H, body: JSON.stringify({ ok: true, started: false, reason: "already running" }) };
    const site = (process.env.URL || "https://rk-tracker-v2.netlify.app").replace(/\/$/, "");
    await fetch(site + "/.netlify/functions/cruise-watch-background", { method: "POST", body: "{}" });
    return { statusCode: 200, headers: H, body: JSON.stringify({ ok: true, started: true }) };
  }
  return { statusCode: 200, headers: H, body: JSON.stringify({ ok: true, data: cur }) };
};
