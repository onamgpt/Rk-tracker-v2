// Netlify scheduled function — runs every 5 min, sends due Telegram messages.
const https = require("https");

const BOT = process.env.TELEGRAM_BOT_TOKEN || "";
const SUPABASE_URL = (process.env.SUPABASE_URL || "").replace(/\/$/, "");
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || "";
const OWNER = "main"; // scheduled messages are stored under the main user
const RESEND_KEY = process.env.RESEND_API_KEY || "";
// No hardcoded fallback here: Netlify's secrets scanner fails the build when a
// configured env var's literal value appears in committed code. MAIL_FROM is
// set in Netlify env vars; if it is ever missing, sendMail no-ops (see below)
// and the Telegram leg still goes out.
const MAIL_FROM = process.env.MAIL_FROM || "";

// Email leg of a reminder. Kept deliberately simple and best-effort: a failed
// email must never stop the Telegram leg from going out.
function sendMail(to, subject, body) {
  return new Promise((resolve) => {
    if (!RESEND_KEY || !MAIL_FROM) return resolve(false);
    const payload = JSON.stringify({
      from: MAIL_FROM,
      to: [to],
      subject: "Reminder: " + subject,
      text: (body ? body + "\n\n" : "") + "— RK Life Tracker, Onam Agarbathi"
    });
    const req = https.request({
      hostname: "api.resend.com", path: "/emails", method: "POST",
      headers: {
        "Authorization": "Bearer " + RESEND_KEY,
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload)
      }
    }, res => { res.on("data", () => {}); res.on("end", () => resolve(res.statusCode < 300)); });
    req.on("error", () => resolve(false));
    req.setTimeout(10000, () => { req.destroy(); resolve(false); });
    req.write(payload); req.end();
  });
}

function tg(method, payload) {
  return new Promise((resolve) => {
    const body = JSON.stringify(payload || {});
    const req = https.request({
      hostname: "api.telegram.org",
      path: "/bot" + BOT + "/" + method,
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) }
    }, res => { let d = ""; res.on("data", c => d += c); res.on("end", () => { try { resolve(JSON.parse(d)); } catch (e) { resolve({ ok: false }); } }); });
    req.on("error", () => resolve({ ok: false }));
    req.write(body); req.end();
  });
}

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
    const req = https.request({ hostname: u.hostname, path: u.pathname + u.search, method, headers }, res => {
      let d = "";
      res.on("data", c => d += c);
      res.on("end", () => { try { resolve(d ? JSON.parse(d) : null); } catch (e) { resolve(null); } });
    });
    req.on("error", () => resolve(null));
    if (body) req.write(body);
    req.end();
  });
}

exports.handler = async () => {
  // Supabase is required to read the queue at all. The bot token is not — a
  // reminder may be email-only.
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return { statusCode: 200, body: JSON.stringify({ ok: false, error: "not configured" }) };
  }

  const now = Date.now();
  let sent = 0;

  try {
    // Read scheduled messages from kv (columns: owner, k, v ; key prefixed pf_)
    const rows = await sb("GET",
      "/rest/v1/kv?owner=eq." + encodeURIComponent(OWNER) + "&k=eq." + encodeURIComponent("pf_tg_scheduled") + "&select=v");
    const store = (Array.isArray(rows) && rows[0] && rows[0].v) ? rows[0].v : { scheduled: [] };
    const list = Array.isArray(store.scheduled) ? store.scheduled : [];
    if (!list.length) return { statusCode: 200, body: JSON.stringify({ ok: true, sent: 0, note: "nothing scheduled" }) };

    const remaining = [];
    // Cache "is this entry done" lookups per run — several occurrences of the
    // same repeating reminder can be due in one pass, and each is a live read
    // against Supabase, so there is no reason to ask the same question twice.
    const doneCache = {};
    async function isEntryDone(ownerName, entryId) {
      const key = ownerName + "|" + entryId;
      if (key in doneCache) return doneCache[key];
      let done = false;
      try {
        const rows = await sb("GET", "/rest/v1/entries?owner=eq." + encodeURIComponent(ownerName) +
          "&id=eq." + encodeURIComponent(entryId) + "&select=data");
        if (Array.isArray(rows) && rows[0]) {
          const d = rows[0].data || {};
          // Gone entirely, or ticked done in the app — either way, stop nagging.
          done = !!d.remindDone;
        } else {
          done = true; // entry no longer exists — nothing left to remind about
        }
      } catch (e) { /* on lookup failure, err toward still sending — a missed
                        reminder is worse than one extra */ }
      doneCache[key] = done;
      return done;
    }

    for (const m of list) {
      const due = Date.parse(m.when);
      if (!isNaN(due) && due <= now) {
        // A reminder tied to an entry gets cancelled the moment that entry is
        // marked done — a scheduled Telegram alarm should not keep firing
        // after the person has already dealt with the thing in the app.
        if (m.entryId && m.owner && await isEntryDone(m.owner, m.entryId)) {
          continue; // drop silently, don't send, don't reschedule
        }
        for (const id of (m.chatIds || [])) {
          await tg("sendMessage", { chat_id: String(id), text: m.text || "", parse_mode: "HTML" });
          sent++;
        }
        for (const addr of (m.emails || [])) {
          if (await sendMail(addr, m.subject || "Reminder", m.body || "")) sent++;
        }
        let next = null;
        if (m.repeat === "daily") {
          const d = new Date(due); d.setDate(d.getDate() + 1); next = d;
        } else if (m.repeat === "weekly") {
          const d = new Date(due); d.setDate(d.getDate() + 7); next = d;
        }
        // "Keep reminding for N days" carries an end date — once the next
        // occurrence would fall past it, the window is over, so stop rather
        // than repeat indefinitely.
        if (next && (!m.until || next.getTime() <= Date.parse(m.until))) {
          remaining.push({ ...m, when: next.toISOString() });
        }
        // one-off, or repeat past its window: drop
      } else {
        remaining.push(m);
      }
    }

    if (sent > 0 || remaining.length !== list.length) {
      await sb("POST", "/rest/v1/kv?on_conflict=owner,k",
        { owner: OWNER, k: "pf_tg_scheduled", v: { scheduled: remaining } },
        { "Prefer": "resolution=merge-duplicates,return=minimal" });
    }

    return { statusCode: 200, body: JSON.stringify({ ok: true, sent, remaining: remaining.length }) };
  } catch (e) {
    return { statusCode: 200, body: JSON.stringify({ ok: false, error: e.message }) };
  }
};
