const T = require("./tally.js");
exports.handler = async (event) => {
  if ((event.headers || {})["x-run-key"] !== T.runKey()) return { statusCode: 403, body: "no" };
  await require("./inward.js").run({}); return { statusCode: 200, body: "ok" };
};
