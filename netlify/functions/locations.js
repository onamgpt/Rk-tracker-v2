// API for the Team Locations page (owner PIN).
const crypto = require("crypto");
const L = require("./loc-lib.js");
const T = require("./tally.js");
const H = { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json", "Access-Control-Allow-Headers": "Content-Type" };
const OK = (o) => ({ statusCode: 200, headers: H, body: JSON.stringify(o) });
const hash = (p) => crypto.createHash("sha256").update("rkpin:" + p).digest("hex");
async function run(job) {
  const base = process.env.URL || "https://rk-tracker-v2.netlify.app";
  await fetch(base + "/.netlify/functions/gmail-daily-background", { method: "POST", headers: { "Content-Type": "application/json", "x-run-key": T.runKey() }, body: JSON.stringify({ job }) }).catch(() => {});
}
exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers: H, body: "" };
  let b = {}; try { b = JSON.parse(event.body || "{}"); } catch (e) { return OK({ error: "bad request" }); }
  const pins = (await L.kvGet("user_pins")) || {};
  if (!pins.main) return OK({ error: "nopin" });
  if (!b.pin || pins.main !== hash(String(b.pin))) return OK({ error: "pin" });
  try {
    if (b.action === "get") {
      const people = Object.values(L.PEOPLE);
      const files = {}; for (const p of people) files[p.name] = await L.loadFile(p.name);
      const [log, mig, gm] = await Promise.all([L.kvGet("loc_log"), L.kvGet("loc_migration"), L.kvGet("gmail_oauth")]);
      return OK({ ok: true, people, bands: L.BANDS, files, log: (log || []).slice(0, 15), migration: mig ? { at: mig.at, updated: mig.updated, status: mig.status || "done", left: mig.left, skipped: mig.skipped || 0, found: mig.found, copied: mig.copied, removed: mig.removed, removedCount: mig.removedCount || 0, pending: (mig.trackerIds || []).length } : null, gmail: !!(gm && gm.refresh) });
    }
    if (["locations", "migrate", "remove", "morning"].includes(b.action)) { await run(b.action); return OK({ ok: true, started: true }); }
    if (b.action === "deleteVisit") {
      const f = await L.loadFile(b.person); const n = f.filter((v) => v.id !== b.id);
      await L.saveFile(b.person, n); return OK({ ok: true, removed: f.length - n.length });
    }
    return OK({ error: "unknown action" });
  } catch (e) { return OK({ error: String(e.message || e) }); }
};
