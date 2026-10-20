// Every 2 hours 09:20–19:20 IST: read new supplier bills (email + Telegram Purchase group) in the background.
const T = require("./tally.js");
exports.handler = async () => {
  const base = process.env.URL || "https://rk-tracker-v2.netlify.app";
  try { await fetch(base + "/.netlify/functions/inward-background", { method: "POST", headers: { "x-run-key": T.runKey() }, body: "{}" }); } catch (e) {}
  return { statusCode: 200, body: "started" };
};
