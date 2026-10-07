// Daily fare check — 09:00 IST. One SerpApi search per active watch;
// Telegram alert when a fare hits the target or a new low.
const travel = require("./travel.js");
exports.handler = async () => {
  try { await travel.runAllWatches(); } catch (e) {}
  return { statusCode: 200, body: "ok" };
};
