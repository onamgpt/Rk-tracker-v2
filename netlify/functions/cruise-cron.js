// Daily 09:45 IST check; starts a cruise scan only when 15 days have passed since the last one.
exports.handler = async () => {
  try {
    const db = require("./db.js");
    const r = JSON.parse((await db.handler({ httpMethod: "POST", body: JSON.stringify({ action: "getPortfolio", user: "main", key: "cruise_watch" }) })).body || "{}");
    const last = r.data && r.data.last_run ? new Date(r.data.last_run).getTime() : 0;
    if (Date.now() - last < 15 * 86400000 - 3600000) return { statusCode: 200, body: "not due" };
    const site = (process.env.URL || "https://rk-tracker-v2.netlify.app").replace(/\/$/, "");
    await fetch(site + "/.netlify/functions/cruise-watch-background", { method: "POST", body: "{}" });
  } catch (e) {}
  return { statusCode: 200, body: "ok" };
};
