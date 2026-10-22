// Daily 09:45 IST check; starts a cruise scan per region only when 15 days have passed since that region's last scan.
const REGIONS = { europe: "cruise_watch", sea: "cruise_watch_sea" };
exports.handler = async () => {
  try {
    const db = require("./db.js");
    const site = (process.env.URL || "https://rk-tracker-v2.netlify.app").replace(/\/$/, "");
    for (const region of Object.keys(REGIONS)) {
      const r = JSON.parse((await db.handler({ httpMethod: "POST", body: JSON.stringify({ action: "getPortfolio", user: "main", key: REGIONS[region] }) })).body || "{}");
      const last = r.data && r.data.last_run ? new Date(r.data.last_run).getTime() : 0;
      if (Date.now() - last < 15 * 86400000 - 3600000) continue;
      await fetch(site + "/.netlify/functions/cruise-watch-background", { method: "POST", body: JSON.stringify({ region }) });
    }
  } catch (e) {}
  return { statusCode: 200, body: "ok" };
};
