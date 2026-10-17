// Every 5 minutes (Mon–Fri): during NSE hours, run the screener; every
// 15 minutes start a fresh live watcher session.
const T = require("./tally.js");
exports.handler = async () => {
  const now = new Date(Date.now() + 5.5 * 3600e3), hm = now.getUTCHours() * 60 + now.getUTCMinutes(), dow = now.getUTCDay();
  if (dow === 0 || dow === 6 || hm < 9 * 60 + 15 || hm > 15 * 60 + 30) return { statusCode: 200, body: "market closed" };
  const base = process.env.URL || "https://rk-tracker-v2.netlify.app", h = { "Content-Type": "application/json", "x-run-key": T.runKey() };
  const jobs = [fetch(base + "/.netlify/functions/spread-screen-background", { method: "POST", headers: h, body: "{}" })];
  if (now.getUTCMinutes() % 15 < 5 && hm <= 15 * 60 + 15) jobs.push(fetch(base + "/.netlify/functions/spread-watch-background", { method: "POST", headers: h, body: "{}" }));
  await Promise.all(jobs.map((p) => p.catch(() => {})));
  return { statusCode: 200, body: "ok" };
};
