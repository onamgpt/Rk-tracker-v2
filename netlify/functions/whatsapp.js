const https = require("https");

// ── WhatsApp Business API integration ───────────────────────────────────
// Actions: sendMessage, sendTemplate, getTemplates

exports.handler = async (event) => {
  const h = {
    "Access-Control-Allow-Origin": "*",
    "Content-Type": "application/json",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS"
  };
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers: h, body: "" };

  try {
    const body = JSON.parse(event.body || "{}");
    const action = body.action || "ping";

    const PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
    const ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;

    if (!PHONE_NUMBER_ID || !ACCESS_TOKEN) {
      return { statusCode: 500, headers: h, body: JSON.stringify({ error: "Missing WhatsApp env vars" }) };
    }

    if (action === "ping") {
      return { statusCode: 200, headers: h, body: JSON.stringify({ ok: true, msg: "WhatsApp API configured", phoneNumberId: PHONE_NUMBER_ID }) };
    }

    // ── sendMessage — plain text (only works within 24h customer service window) ──
    if (action === "sendMessage") {
      const { to, message } = body;
      if (!to || !message) return { statusCode: 400, headers: h, body: JSON.stringify({ error: "Missing to/message" }) };

      const result = await waApiCall(PHONE_NUMBER_ID, ACCESS_TOKEN, {
        messaging_product: "whatsapp",
        to: formatPhone(to),
        type: "text",
        text: { body: message }
      });
      return { statusCode: 200, headers: h, body: JSON.stringify({ ok: true, result }) };
    }

    // ── sendTemplate — required for first contact / outside 24h window ──
    if (action === "sendTemplate") {
      const { to, templateName, languageCode, params } = body;
      if (!to || !templateName) return { statusCode: 400, headers: h, body: JSON.stringify({ error: "Missing to/templateName" }) };

      const components = (params && params.length > 0) ? [{
        type: "body",
        parameters: params.map(p => ({ type: "text", text: String(p) }))
      }] : [];

      const result = await waApiCall(PHONE_NUMBER_ID, ACCESS_TOKEN, {
        messaging_product: "whatsapp",
        to: formatPhone(to),
        type: "template",
        template: {
          name: templateName,
          language: { code: languageCode || "en_US" },
          components
        }
      });
      return { statusCode: 200, headers: h, body: JSON.stringify({ ok: true, result }) };
    }

    // ── getTemplates — list approved message templates ──
    if (action === "getTemplates") {
      const WABA_ID = process.env.WHATSAPP_BUSINESS_ACCOUNT_ID;
      const result = await graphApiGet(`/${WABA_ID}/message_templates`, ACCESS_TOKEN);
      return { statusCode: 200, headers: h, body: JSON.stringify({ ok: true, templates: result.data || [] }) };
    }

    return { statusCode: 400, headers: h, body: JSON.stringify({ error: "Unknown action: " + action }) };

  } catch(e) {
    return { statusCode: 500, headers: h, body: JSON.stringify({ error: e.message }) };
  }
};

function formatPhone(phone) {
  // Ensure phone has country code, default India +91
  let p = String(phone).replace(/[^\d]/g, "");
  if (p.length === 10) p = "91" + p;
  return p;
}

function waApiCall(phoneNumberId, token, payload) {
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify(payload);
    const req = https.request({
      hostname: "graph.facebook.com",
      path: "/v21.0/" + phoneNumberId + "/messages",
      method: "POST",
      headers: {
        "Authorization": "Bearer " + token,
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(postData)
      }
    }, (res) => {
      let data = "";
      res.on("data", c => data += c);
      res.on("end", () => { try { resolve(JSON.parse(data)); } catch(e) { resolve({ raw: data }); } });
    });
    req.on("error", reject);
    req.write(postData);
    req.end();
  });
}

function graphApiGet(path, token) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: "graph.facebook.com",
      path: "/v21.0" + path,
      method: "GET",
      headers: { "Authorization": "Bearer " + token }
    }, (res) => {
      let data = "";
      res.on("data", c => data += c);
      res.on("end", () => { try { resolve(JSON.parse(data)); } catch(e) { resolve({ raw: data }); } });
    });
    req.on("error", reject);
    req.end();
  });
}
