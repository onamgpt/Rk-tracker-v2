// Morning Gmail run (9:15 IST, from tally-daily) and on-demand jobs:
//   job "morning"  — #Trackerv23 emails → tracker entries; location emails → Team Locations
//   job "locations"— location emails only (Check now)
//   job "migrate"  — copy old location entries out of the main tracker
//   job "remove"   — remove those copied entries from the main tracker
const T = require("./tally.js");
const L = require("./loc-lib.js");
const K = require("./trk-mail-lib.js");
exports.handler = async (event) => {
  if ((event.headers || {})["x-run-key"] !== T.runKey()) return { statusCode: 403, body: "no" };
  let b = {}; try { b = JSON.parse(event.body || "{}"); } catch (e) {}
  const job = b.job || "morning";
  const log = (await L.kvGet("loc_log")) || [];
  const entry = { at: new Date().toISOString(), job, lines: [], error: "" };
  try {
    if (job === "morning") {
      try { const t = await K.importTrackerEmails(3); entry.lines.push("#Trackerv23: " + (t.imported.length ? t.imported.length + " imported" : (t.note || "none")));
        if (t.imported.length) await T.tg("📧 <b>#Trackerv23 emails imported (9:15)</b>\n" + t.imported.map((x) => "• " + x).join("\n"));
      } catch (e) { entry.lines.push("#Trackerv23: " + e.message); if (!/not connected/i.test(e.message)) await T.tg("⚠️ #Trackerv23 email import: " + e.message); }
    }
    if (job === "morning" || job === "locations") {
      const r = await L.importLocationEmails(job === "locations" ? 10 : 4);
      entry.lines.push("Locations: " + r.added.length + " added" + (r.skipped.length ? ", " + r.skipped.length + " skipped" : ""));
      entry.added = r.added; entry.skipped = r.skipped.slice(0, 20);
      if (r.added.length && job === "morning") await T.tg("📍 <b>Team locations received</b>\n" + r.added.map((x) => "• " + x).join("\n"));
    }
    if (job === "migrate") {
      const r = await L.migrateFromTracker(90);
      entry.lines.push("Old entries: " + r.copied + " copied so far, " + r.left + " of " + r.found + " still to go");
      if (r.left && r.batch) {   // next batch in a fresh run
        const base = process.env.URL || "https://rk-tracker-v2.netlify.app";
        await fetch(base + "/.netlify/functions/gmail-daily-background", { method: "POST", headers: { "Content-Type": "application/json", "x-run-key": T.runKey() }, body: JSON.stringify({ job: "migrate" }) }).catch(() => {});
      }
    }
    if (job === "remove") { const r = await L.removeMigrated(); entry.lines.push("Removed " + r.removed + " old location entries from the main tracker"); }
  } catch (e) { entry.error = e.message; }
  log.unshift(entry); await L.kvSet("loc_log", log.slice(0, 60));
  return { statusCode: 200, body: "ok" };
};
