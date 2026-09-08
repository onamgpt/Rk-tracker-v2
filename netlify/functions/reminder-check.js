// Read-only diagnostic for the reminder pipeline.
//
// Deliberately NOT scheduled in netlify.toml — Netlify refuses HTTP invocation
// of scheduled functions, which is why hitting telegram-scheduler directly
// returned an empty body.
//
// Reports whether each piece of configuration is present (booleans only, never
// values) and what is actually sitting in the queue, so a reminder that fails
// can be traced without guessing. Sends nothing and changes nothing.

const https = require("https");

const BOT = process.env.TELEGRAM_BOT_TOKEN || "";
const SUPABASE_URL = (process.env.SUPABASE_URL || "").replace(/\/$/, "");
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || "";
const RESEND_KEY = process.env.RESEND_API_KEY || "";
const MAIL_FROM = process.env.MAIL_FROM || "";
const OWNER = "main";

function sb(path) {
  return new Promise((resolve) => {
    if (!SUPABASE_URL || !SUPABASE_KEY) return resolve({ __error: "supabase not configured" });
    const u = new URL(SUPABASE_URL + path);
    const req = https.request({
      hostname: u.hostname, path: u.pathname + u.search, method: "GET",
      headers: { "apikey": SUPABASE_KEY, "Authorization": "Bearer " + SUPABASE_KEY }
    }, res => {
      let d = "";
      res.on("data", c => d += c);
      res.on("end", () => {
        try { resolve(d ? JSON.parse(d) : null); }
        catch (e) { resolve({ __error: "bad JSON from supabase", status: res.statusCode }); }
      });
    });
    req.on("error", e => resolve({ __error: e.message }));
    req.end();
  });
}

// Confirms the bot token actually works, without sending anyone a message.
function botOk() {
  return new Promise((resolve) => {
    if (!BOT) return resolve({ ok: false, why: "TELEGRAM_BOT_TOKEN not set" });
    const req = https.request({ hostname: "api.telegram.org", path: "/bot" + BOT + "/getMe", method: "GET" },
      res => {
        let d = "";
        res.on("data", c => d += c);
        res.on("end", () => {
          try {
            const j = JSON.parse(d);
            resolve({ ok: !!j.ok, why: j.ok ? ("@" + (j.result && j.result.username)) : (j.description || "rejected") });
          } catch (e) { resolve({ ok: false, why: "unparseable reply" }); }
        });
      });
    req.on("error", e => resolve({ ok: false, why: e.message }));
    req.end();
  });
}

exports.handler = async () => {
  const now = Date.now();
  const out = {
    serverTimeUTC: new Date(now).toISOString(),
    config: {
      TELEGRAM_BOT_TOKEN: !!BOT,
      SUPABASE_URL: !!SUPABASE_URL,
      SUPABASE_SERVICE_KEY: !!SUPABASE_KEY,
      RESEND_API_KEY: !!RESEND_KEY,
      MAIL_FROM: !!MAIL_FROM,
      MAIL_FROM_domain: MAIL_FROM ? String(MAIL_FROM).split("@")[1] || "(no @)" : null
    }
  };

  out.telegramBot = await botOk();

  const rows = await sb("/rest/v1/kv?owner=eq." + encodeURIComponent(OWNER) +
    "&k=eq." + encodeURIComponent("pf_tg_scheduled") + "&select=v");

  if (rows && rows.__error) {
    out.queue = { error: rows.__error };
    return { statusCode: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify(out, null, 2) };
  }

  const list = (Array.isArray(rows) && rows[0] && rows[0].v && Array.isArray(rows[0].v.scheduled))
    ? rows[0].v.scheduled : null;

  if (list === null) {
    out.queue = { found: false, note: "no pf_tg_scheduled row for owner 'main' — nothing has ever been queued" };
  } else {
    out.queue = {
      found: true,
      count: list.length,
      items: list.map(m => ({
        id: m.id,
        when: m.when,
        due: !isNaN(Date.parse(m.when)) && Date.parse(m.when) <= now,
        chatIds: (m.chatIds || []).length,
        emails: (m.emails || []).length,
        entryId: m.entryId || null,
        owner: m.owner || null,
        repeat: m.repeat || null,
        textPreview: String(m.text || "").slice(0, 60)
      }))
    };
    out.queue.dueNow = out.queue.items.filter(i => i.due).length;
  }

  return { statusCode: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify(out, null, 2) };
};
