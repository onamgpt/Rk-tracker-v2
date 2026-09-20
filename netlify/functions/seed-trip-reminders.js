// One-shot seeder: loads the Sep/Oct 2026 Europe trip reminders into the
// existing pf_tg_scheduled queue that telegram-scheduler.js drains every 5 min.
//
// Open /.netlify/functions/seed-trip-reminders once and it merges them in.
// Safe to re-run: every item carries tag "trip2026" and the whole tagged set is
// replaced each time, so re-running updates rather than duplicates.
//
// Extra recipients without a redeploy:
//   ?chat=123456789,987654321   additional Telegram chat IDs
//   ?email=a@b.com,c@d.com      additional email addresses
//   ?dry=1                      show what would be written, write nothing

const https = require("https");

const SUPABASE_URL = (process.env.SUPABASE_URL || "").replace(/\/$/, "");
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || "";
const OWNER = "main";
const KEY = "pf_tg_scheduled";
const TAG = "trip2026";

const BASE_CHATS = ["8632288596"];
const BASE_EMAILS = ["onamagarbathi@gmail.com"];

// when  — UTC. The scheduler compares against Date.now(), so UTC keeps these
//         correct whether he is in Bangalore, Zurich, Italy or Cairo.
// local — what the clock says where the thing actually happens, for the text.
const ITEMS = [
  {
    when: "2026-09-22T04:30:00Z",
    subject: "Book Rome \u2192 Cairo flight",
    head: "\u2708\ufe0f Book Rome \u2192 Cairo",
    body: "Egypt e-visas are approved for all three. Departure 3 Oct. Fares climb from here.\n"
        + "Skyscanner: https://www.skyscanner.net/transport/flights/rome/cair/\n"
        + "EgyptAir: https://www.egyptair.com/"
  },
  {
    when: "2026-09-25T07:30:00Z",
    subject: "Ryanair FR824 check-in opens",
    head: "\ud83e\uddf3 Ryanair check-in open \u2014 FR824",
    body: "Venice \u2192 Naples, 27 Sep 06:30. Booking X6ZD6D.\n"
        + "Checked bags are on Brunda and Tassmai only. Add cabin bags now if the hand luggage is trolley-sized \u2014 gate fees are far worse.\n"
        + "https://www.ryanair.com/gb/en/check-in"
  },
  {
    when: "2026-09-27T06:00:00Z",
    subject: "Naples airport transfer \u2014 driver at 09:00",
    head: "\ud83d\ude97 Naples transfer in 1 hour",
    body: "Order w-7338467-1. Driver waits in the Arrivals hall with a name sign.\n"
        + "Direct to Il Parid\u00e0, Via dei Prefetturi 6, Amalfi. No stops booked."
  },
  {
    when: "2026-09-29T07:30:00Z",
    subject: "Collect bags \u2014 Amalfi ferry at 14:10",
    head: "\u26f4\ufe0f Ferry today 14:10 \u2014 Amalfi to Salerno",
    body: "Checkout is 11:00; Il Parid\u00e0 holds the bags. Collect by 13:45 and walk to the pier.\n"
        + "Travelmar TRP2682862 \u2014 3 adults + 2 baggage pieces. Arrives Salerno Concordia 14:45.\n"
        + "If the sea is rough and it is cancelled: SITA bus from Piazza Flavio Gioia, leave by 15:30, or a car (~\u20ac180)."
  },
  {
    when: "2026-09-29T15:00:00Z",
    subject: "Italo 9962 to Rome \u2014 departs 18:04",
    head: "\ud83d\ude84 Train to Rome in 1 hour",
    body: "Salerno 18:04 \u2192 Roma Termini 20:21. Ticket TDPPNP. Wagon 11, seats 1, 2, 3.\n"
        + "Doors close 2 minutes before departure.\n"
        + "At Termini take a taxi from the official rank to Casa di Egeria, Via di San Giovanni in Laterano 226."
  },
  {
    when: "2026-09-30T04:30:00Z",
    subject: "Vatican Museums tour \u2014 08:00",
    head: "\ud83c\udfdb\ufe0f Vatican tour at 08:00",
    body: "Guided tour with earphones. Order 2L2N0MR9AGPATTDZR1.\n"
        + "Carry passports. Shoulders and knees covered."
  },
  {
    when: "2026-10-01T10:00:00Z",
    subject: "Colosseum entry \u2014 12:45",
    head: "\ud83c\udfdf\ufe0f Colosseum at 12:45",
    body: "Arrive by 12:30 \u2014 entry is at Piazza del Colosseo, Valadier gate.\n"
        + "Photo ID required. PopGuide app: GSR-000238 / 58613.\n"
        + "Ticket covers Colosseum levels 1 and 2, Roman Forum and Palatine. Not the Arena, Underground or Attic.\n"
        + "No backpacks or trolleys allowed inside."
  }
];

function sb(method, path, payload, extraHeaders) {
  return new Promise((resolve) => {
    const u = new URL(SUPABASE_URL + path);
    const body = payload !== undefined ? JSON.stringify(payload) : null;
    const headers = {
      "apikey": SUPABASE_KEY,
      "Authorization": "Bearer " + SUPABASE_KEY,
      "Content-Type": "application/json",
      ...(extraHeaders || {})
    };
    if (body) headers["Content-Length"] = Buffer.byteLength(body);
    const req = https.request(
      { hostname: u.hostname, path: u.pathname + u.search, method, headers },
      res => {
        let d = "";
        res.on("data", c => d += c);
        res.on("end", () => {
          try { resolve({ status: res.statusCode, data: d ? JSON.parse(d) : null }); }
          catch (e) { resolve({ status: res.statusCode, data: null }); }
        });
      }
    );
    req.on("error", e => resolve({ status: 0, data: null, error: e.message }));
    req.write(body || "");
    req.end();
  });
}

function splitList(s) {
  return String(s || "").split(",").map(x => x.trim()).filter(Boolean);
}

exports.handler = async (event) => {
  const json = (code, obj) => ({
    statusCode: code,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(obj, null, 2)
  });

  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return json(200, { ok: false, error: "Supabase env vars are not set on this deploy" });
  }

  const q = (event && event.queryStringParameters) || {};
  const chatIds = [...new Set(BASE_CHATS.concat(splitList(q.chat)))];
  const emails = [...new Set(BASE_EMAILS.concat(splitList(q.email)))];

  const seeded = ITEMS.map(it => ({
    tag: TAG,
    when: it.when,
    chatIds,
    emails,
    // Telegram leg
    text: "<b>" + it.head + "</b>\n" + it.body,
    // Email leg
    subject: it.subject,
    body: it.body
  }));

  if (q.dry) {
    return json(200, { ok: true, dryRun: true, chatIds, emails, count: seeded.length, seeded });
  }

  const read = await sb("GET",
    "/rest/v1/kv?owner=eq." + encodeURIComponent(OWNER) +
    "&k=eq." + encodeURIComponent(KEY) + "&select=v");

  const existing = (Array.isArray(read.data) && read.data[0] && read.data[0].v)
    ? read.data[0].v : { scheduled: [] };
  const prior = Array.isArray(existing.scheduled) ? existing.scheduled : [];

  // Drop any previous trip2026 items, keep everything else untouched.
  const kept = prior.filter(m => m && m.tag !== TAG);
  const merged = kept.concat(seeded);

  const write = await sb("POST", "/rest/v1/kv?on_conflict=owner,k",
    { owner: OWNER, k: KEY, v: { scheduled: merged } },
    { "Prefer": "resolution=merge-duplicates,return=minimal" });

  const ok = write.status >= 200 && write.status < 300;

  return json(200, {
    ok,
    writeStatus: write.status,
    chatIds,
    emails,
    otherRemindersUntouched: kept.length,
    tripRemindersSeeded: seeded.length,
    queueTotal: merged.length,
    firesAt: seeded.map(s => s.when + "  \u2014  " + s.subject)
  });
};
