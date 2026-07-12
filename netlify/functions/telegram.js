const https = require("https");

// Token from env (set TELEGRAM_BOT_TOKEN in Netlify). Falls back to legacy value only if env missing.
const BOT = process.env.TELEGRAM_BOT_TOKEN || "";

function tg(method, payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload || {});
    const req = https.request({
      hostname: "api.telegram.org",
      path: "/bot" + BOT + "/" + method,
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) }
    }, res => {
      let data = "";
      res.on("data", c => data += c);
      res.on("end", () => { try { resolve(JSON.parse(data)); } catch (e) { resolve({ ok: false, raw: data }); } });
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

exports.handler = async (event) => {
  const h = {
    "Access-Control-Allow-Origin": "*",
    "Content-Type": "application/json",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS"
  };
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers: h, body: "" };
  if (!BOT) return { statusCode: 500, headers: h, body: JSON.stringify({ ok: false, error: "TELEGRAM_BOT_TOKEN not set in Netlify env vars" }) };

  try {
    const body = JSON.parse(event.body || "{}");
    const action = body.action || "send";

    // 1) SEND a message to one or many chat IDs
    if (action === "send") {
      const text = body.message || "";
      let chatIds = body.chatIds || (body.chatId ? [body.chatId] : []);
      if (!text) return { statusCode: 400, headers: h, body: JSON.stringify({ ok: false, error: "no message" }) };
      if (!chatIds.length) return { statusCode: 400, headers: h, body: JSON.stringify({ ok: false, error: "no recipients" }) };

      const results = [];
      for (const id of chatIds) {
        const r = await tg("sendMessage", { chat_id: String(id), text: text, parse_mode: "HTML" });
        results.push({ chatId: id, ok: !!r.ok, error: r.ok ? null : (r.description || "failed") });
      }
      const sent = results.filter(r => r.ok).length;
      return { statusCode: 200, headers: h, body: JSON.stringify({ ok: true, sent, total: results.length, results }) };
    }

    // 2) GET UPDATES — discover who has messaged the bot (to learn their chat IDs)
    if (action === "contacts") {
      const r = await tg("getUpdates", { limit: 100, timeout: 0 });
      const people = {};
      if (r && r.ok && Array.isArray(r.result)) {
        r.result.forEach(u => {
          const m = u.message || u.edited_message;
          if (m && m.chat && m.chat.id) {
            const c = m.chat;
            const name = [c.first_name, c.last_name].filter(Boolean).join(" ") || c.username || String(c.id);
            people[String(c.id)] = { chatId: String(c.id), name: name, username: c.username || "", type: c.type };
          }
        });
      }
      return { statusCode: 200, headers: h, body: JSON.stringify({ ok: true, contacts: Object.values(people) }) };
    }

    // 3) TEST — check the bot is alive
    if (action === "test") {
      const r = await tg("getMe", {});
      return { statusCode: 200, headers: h, body: JSON.stringify(r) };
    }

    return { statusCode: 400, headers: h, body: JSON.stringify({ ok: false, error: "unknown action" }) };
  } catch (e) {
    return { statusCode: 500, headers: h, body: JSON.stringify({ ok: false, error: e.message }) };
  }
};
