// Every 2 hours, 9 am–7 pm IST: read new CSD POs and payment advices from Gmail (background job).
const T = require("./tally.js");
exports.handler = async () => {
  const base = process.env.URL || "https://rk-tracker-v2.netlify.app";
  try { await fetch(base + "/.netlify/functions/csd-mail-background", { method: "POST", headers: { "Content-Type": "application/json", "x-run-key": T.runKey() }, body: "{}" }); } catch (e) {}
  return { statusCode: 200, body: "started" };
};
