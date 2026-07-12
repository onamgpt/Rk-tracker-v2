// Runs on a schedule; sends any due Telegram messages + tracker auto-reminders.
const https = require("https");

const BOT = process.env.TELEGRAM_BOT_TOKEN || "";
const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || "";

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

function sb(path, method, payload) {
  return new Promise((resolve) => {
    const url = new URL(SUPABASE_URL + path);
    const body = payload ? JSON.stringify(payload) : null;
    const req = https.request({
      hostname: url.hostname, path: url.pathname + url.search, method: method,
      headers: {
        "apikey": SUPABASE_KEY, "Authorization": "Bearer " + SUPABASE_KEY,
        "Content-Type": "application/json", "Prefer": "return=representation",
        ...(body ? { "Content-Length": Buffer.byteLength(body) } : {})
      }
    }, res => { let d = ""; res.on("data", c => d += c); res.on("end", () => { try { resolve(JSON.parse(d || "[]")); } catch (e) { resolve([]); } }); });
    req.on("error", () => resolve([]));
    if (body) req.write(body);
    req.end();
  });
}

exports.handler = async () => {
  if (!BOT || !SUPABASE_URL) return { statusCode: 200, body: "not configured" };
  const now = Date.now();
  let sent = 0;

  try {
    // Load scheduled messages (kv key = "tg_scheduled")
    const rows = await sb("/rest/v1/kv?key=eq.tg_scheduled&select=value", "GET");
    const store = (rows && rows[0] && rows[0].value) || { scheduled: [] };
    const list = store.scheduled || [];
    const remaining = [];

    for (const m of list) {
      const due = Date.parse(m.when);
      if (!isNaN(due) && due <= now && !m.sent) {
        for (const id of (m.chatIds || [])) {
          await tg("sendMessage", { chat_id: String(id), text: m.text, parse_mode: "HTML" });
          sent++;
        }
        if (m.repeat === "daily") { const d = new Date(due); d.setDate(d.getDate() + 1); m.when = d.toISOString(); remaining.push(m); }
        else if (m.repeat === "weekly") { const d = new Date(due); d.setDate(d.getDate() + 7); m.when = d.toISOString(); remaining.push(m); }
        // one-off: drop it
      } else {
        remaining.push(m);
      }
    }

    if (sent > 0 || remaining.length !== list.length) {
      await sb("/rest/v1/kv?key=eq.tg_scheduled", "PATCH", { value: { scheduled: remaining } });
    }
  } catch (e) {}

  return { statusCode: 200, body: JSON.stringify({ sent }) };
};
