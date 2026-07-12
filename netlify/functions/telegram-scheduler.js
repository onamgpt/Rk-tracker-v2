// Netlify scheduled function — runs every 5 min, sends due Telegram messages.
const https = require("https");

const BOT = process.env.TELEGRAM_BOT_TOKEN || "";
const SUPABASE_URL = (process.env.SUPABASE_URL || "").replace(/\/$/, "");
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || "";
const OWNER = "main"; // scheduled messages are stored under the main user

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
  if (!BOT || !SUPABASE_URL || !SUPABASE_KEY) {
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
    for (const m of list) {
      const due = Date.parse(m.when);
      if (!isNaN(due) && due <= now) {
        for (const id of (m.chatIds || [])) {
          await tg("sendMessage", { chat_id: String(id), text: m.text || "", parse_mode: "HTML" });
          sent++;
        }
        if (m.repeat === "daily") {
          const d = new Date(due); d.setDate(d.getDate() + 1);
          remaining.push({ ...m, when: d.toISOString() });
        } else if (m.repeat === "weekly") {
          const d = new Date(due); d.setDate(d.getDate() + 7);
          remaining.push({ ...m, when: d.toISOString() });
        }
        // one-off: drop
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
