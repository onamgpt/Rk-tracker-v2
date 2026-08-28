const https = require("https");

// ── WhatsApp Business API integration ───────────────────────────────────
// Actions: sendMessage, sendTemplate, getTemplates, submitOrderTemplates,
//          sendFestivalGreeting, optOutStatus

const SUPABASE_URL   = process.env.SUPABASE_URL || "";
const SERVICE_KEY    = process.env.SUPABASE_SERVICE_KEY || "";
const MARKETING_GAP_DAYS = 30; // "good company" cap: at most 1 non-transactional msg / 30 days

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
    const WABA_ID = process.env.WHATSAPP_BUSINESS_ACCOUNT_ID;

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

      const result = await sendTemplateMsg(PHONE_NUMBER_ID, ACCESS_TOKEN, to, templateName, languageCode, params);
      return { statusCode: 200, headers: h, body: JSON.stringify({ ok: true, result }) };
    }

    // ── getTemplates — list approved message templates + their status ──
    if (action === "getTemplates") {
      if (!WABA_ID) return { statusCode: 500, headers: h, body: JSON.stringify({ error: "WHATSAPP_BUSINESS_ACCOUNT_ID not set" }) };
      const result = await graphApiGet(`/${WABA_ID}/message_templates?limit=50`, ACCESS_TOKEN);
      return { statusCode: 200, headers: h, body: JSON.stringify({ ok: true, templates: result.data || [] }) };
    }

    // ── submitOrderTemplates — one-shot: submits all 5 templates for Meta review ──
    // Safe to call more than once: Meta rejects an exact-duplicate name+language
    // with a clear "already exists" error, which we surface per-template rather
    // than letting one failure hide the rest.
    if (action === "submitOrderTemplates") {
      if (!WABA_ID) return { statusCode: 500, headers: h, body: JSON.stringify({ error: "WHATSAPP_BUSINESS_ACCOUNT_ID not set" }) };

      const templates = [
        {
          name: "order_confirmation",
          category: "UTILITY",
          language: "en",
          components: [
            { type: "BODY", text: "Hi {{1}}, thank you for your order from Onam Agarbathi! Order {{2}} received for Rs.{{3}}. We'll ship it soon." }
          ]
        },
        {
          name: "order_shipped",
          category: "UTILITY",
          language: "en",
          components: [
            { type: "BODY", text: "Hi {{1}}, your order {{2}} has shipped via {{3}}. Expect delivery in 3-5 days. Thank you for choosing Onam Agarbathi!" }
          ]
        },
        {
          name: "order_delivered",
          category: "UTILITY",
          language: "en",
          components: [
            { type: "BODY", text: "Hi {{1}}, your order {{2}} was delivered. We hope you love it! Thank you for choosing Onam Agarbathi." }
          ]
        },
        {
          name: "festival_greeting",
          category: "MARKETING",
          language: "en",
          components: [
            { type: "BODY", text: "Wishing you and your family a very happy {{1}} from all of us at Onam Agarbathi! May your home be filled with fragrance and joy. Reply STOP to opt out of messages like this." }
          ]
        },
        {
          name: "reorder_nudge",
          category: "MARKETING",
          language: "en",
          components: [
            { type: "BODY", text: "Hi {{1}}, hope you're doing well! Your Vaishak agarbathi supply might be running low. Reorder anytime at onamagarbathi.com. Reply STOP to opt out of messages like this." }
          ]
        }
      ];

      const results = [];
      for (const t of templates) {
        try {
          const r = await graphApiPost(`/${WABA_ID}/message_templates`, ACCESS_TOKEN, t);
          results.push({ name: t.name, ok: !r.error, result: r });
        } catch (e) {
          results.push({ name: t.name, ok: false, error: e.message });
        }
      }
      return { statusCode: 200, headers: h, body: JSON.stringify({ ok: true, results }) };
    }

    // ── sendFestivalGreeting — manual trigger, respects opt-out + 30-day cap ──
    if (action === "sendFestivalGreeting") {
      const { festivalName } = body;
      if (!festivalName) return { statusCode: 400, headers: h, body: JSON.stringify({ error: "festivalName required" }) };
      if (!SUPABASE_URL || !SERVICE_KEY) return { statusCode: 500, headers: h, body: JSON.stringify({ error: "Supabase not configured" }) };

      const repeatCustomers = await getRepeatCustomers();
      const eligible = await filterEligibleForMarketing(repeatCustomers);

      const sent = [];
      const skipped = [];
      for (const c of eligible) {
        try {
          const res = await sendTemplateMsg(PHONE_NUMBER_ID, ACCESS_TOKEN, c.phone, "festival_greeting", "en", [festivalName]);
          if (res && res.error) { skipped.push({ phone: c.phone, error: res.error.message || res.error }); continue; }
          sent.push(c.phone);
        } catch (e) {
          skipped.push({ phone: c.phone, error: e.message });
        }
      }
      await logMarketingSends(sent);
      return { statusCode: 200, headers: h, body: JSON.stringify({ ok: true, sentCount: sent.length, skippedCount: skipped.length, totalEligible: eligible.length, totalRepeatCustomers: repeatCustomers.length }) };
    }

    // ── optOutStatus — quick check for the admin panel ──
    if (action === "optOutStatus") {
      if (!SUPABASE_URL || !SERVICE_KEY) return { statusCode: 500, headers: h, body: JSON.stringify({ error: "Supabase not configured" }) };
      const optouts = await kvGet("wa_optouts");
      const list = Object.keys(optouts).map(p => ({ phone: p, opted_out_at: optouts[p] }))
        .sort((a, b) => String(b.opted_out_at).localeCompare(String(a.opted_out_at)));
      return { statusCode: 200, headers: h, body: JSON.stringify({ ok: true, optouts: list, count: list.length }) };
    }

    return { statusCode: 400, headers: h, body: JSON.stringify({ error: "Unknown action: " + action }) };

  } catch(e) {
    return { statusCode: 500, headers: h, body: JSON.stringify({ error: e.message }) };
  }
};

// ── Supabase helpers ─────────────────────────────────────────────────────
// Opt-outs and the marketing send log live in the existing `kv` table
// (owner / k / v), the same store the tracker already uses for dropdowns and
// portfolios. No new tables, no schema change. Both are single JSON objects
// keyed by phone number:
//   kv[main, wa_optouts]       = { "9845563633": "2026-08-28T...", ... }
//   kv[main, wa_marketing_log] = { "9845563633": "2026-08-28T...", ... }
function kvGet(key) {
  return new Promise((resolve) => {
    if (!SUPABASE_URL || !SERVICE_KEY) return resolve({});
    const u = new URL(SUPABASE_URL + "/rest/v1/kv?owner=eq.main&k=eq." + encodeURIComponent(key) + "&select=v");
    const req = https.request({
      hostname: u.hostname, path: u.pathname + u.search, method: "GET",
      headers: { "apikey": SERVICE_KEY, "Authorization": "Bearer " + SERVICE_KEY }
    }, (res) => {
      let data = "";
      res.on("data", c => data += c);
      res.on("end", () => {
        try {
          const j = JSON.parse(data);
          resolve((Array.isArray(j) && j[0] && j[0].v) ? j[0].v : {});
        } catch (e) { resolve({}); }
      });
    });
    req.on("error", () => resolve({}));
    req.setTimeout(10000, () => { req.destroy(); resolve({}); });
    req.end();
  });
}

function kvPut(key, value) {
  return new Promise((resolve) => {
    if (!SUPABASE_URL || !SERVICE_KEY) return resolve(false);
    const u = new URL(SUPABASE_URL + "/rest/v1/kv?on_conflict=owner,k");
    const bodyStr = JSON.stringify({ owner: "main", k: key, v: value });
    const req = https.request({
      hostname: u.hostname, path: u.pathname + u.search, method: "POST",
      headers: {
        "apikey": SERVICE_KEY, "Authorization": "Bearer " + SERVICE_KEY,
        "Content-Type": "application/json", "Prefer": "resolution=merge-duplicates",
        "Content-Length": Buffer.byteLength(bodyStr)
      }
    }, (res) => { res.on("data", () => {}); res.on("end", () => resolve(res.statusCode < 300)); });
    req.on("error", () => resolve(false));
    req.setTimeout(10000, () => { req.destroy(); resolve(false); });
    req.write(bodyStr);
    req.end();
  });
}

function sbGetOrders() {
  return new Promise((resolve) => {
    if (!SUPABASE_URL || !SERVICE_KEY) return resolve([]);
    const u = new URL(SUPABASE_URL + "/rest/v1/orders?select=customer_phone,customer_name&limit=5000");
    const req = https.request({
      hostname: u.hostname, path: u.pathname + u.search, method: "GET",
      headers: { "apikey": SERVICE_KEY, "Authorization": "Bearer " + SERVICE_KEY }
    }, (res) => {
      let data = "";
      res.on("data", c => data += c);
      res.on("end", () => { try { resolve(JSON.parse(data) || []); } catch (e) { resolve([]); } });
    });
    req.on("error", () => resolve([]));
    req.setTimeout(15000, () => { req.destroy(); resolve([]); });
    req.end();
  });
}

async function getRepeatCustomers() {
  const rows = await sbGetOrders();
  const byPhone = {};
  (rows || []).forEach(o => {
    const p = String(o.customer_phone || "").trim();
    if (!p) return;
    if (!byPhone[p]) byPhone[p] = { phone: p, name: o.customer_name || "", orders: 0 };
    byPhone[p].orders++;
  });
  return Object.values(byPhone).filter(c => c.orders >= 2);
}

async function filterEligibleForMarketing(customers) {
  const optouts = await kvGet("wa_optouts");
  const lastSent = await kvGet("wa_marketing_log");
  const now = Date.now();
  return customers.filter(c => {
    if (optouts[c.phone]) return false;
    const last = lastSent[c.phone];
    if (!last) return true;
    return (now - new Date(last).getTime()) / 86400000 >= MARKETING_GAP_DAYS;
  });
}

// Written once after the whole batch rather than per-message, so a festival
// run is a single read-modify-write instead of N of them racing each other.
async function logMarketingSends(phones) {
  if (!phones.length) return;
  const log = await kvGet("wa_marketing_log");
  const stamp = new Date().toISOString();
  phones.forEach(p => { log[p] = stamp; });
  await kvPut("wa_marketing_log", log);
}

// ── WhatsApp Graph API helpers ───────────────────────────────────────────
function formatPhone(phone) {
  let p = String(phone).replace(/[^\d]/g, "");
  if (p.length === 10) p = "91" + p;
  return p;
}

function sendTemplateMsg(phoneNumberId, token, to, templateName, languageCode, params) {
  const components = (params && params.length > 0) ? [{
    type: "body",
    parameters: params.map(p => ({ type: "text", text: String(p) }))
  }] : [];
  return waApiCall(phoneNumberId, token, {
    messaging_product: "whatsapp",
    to: formatPhone(to),
    type: "template",
    template: { name: templateName, language: { code: languageCode || "en_US" }, components }
  });
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

function graphApiPost(path, token, payload) {
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify(payload);
    const req = https.request({
      hostname: "graph.facebook.com",
      path: "/v21.0" + path,
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
