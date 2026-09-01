// Drains the WhatsApp scheduled queue. Runs every 15 minutes.
//
// A scheduled item looks like:
//   { id, templateName, params:[], recipients:["9198…"], when:"2026-09-02T10:00",
//     repeat:"once|daily|weekly|monthly", category:"UTILITY|MARKETING",
//     status:"pending|sent|failed", lastRun, lastError }
//
// Marketing sends are gated by the opt-out list and the same frequency rule
// the festival sender uses — a scheduler that ignores opt-outs would get the
// number blocked, which costs far more than a missed message.

const https = require("https");

const ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;
const PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

const MARKETING_GAP_DAYS = 7;

exports.handler = async () => {
  if (!ACCESS_TOKEN || !PHONE_NUMBER_ID) {
    return json({ ok: false, error: "WhatsApp env vars not set" });
  }

  const store = await kvGet("wa_scheduled");
  const items = Array.isArray(store.scheduled) ? store.scheduled : [];
  if (!items.length) return json({ ok: true, checked: 0, sent: 0 });

  const optouts = await kvGet("wa_optouts");
  const marketingLog = await kvGet("wa_marketing_log");
  const lastInbound = await kvGet("wa_last_inbound");
  const now = Date.now();

  // A number is reachable with plain text only if it messaged us within the
  // last 24 hours. Checked at send time, not schedule time — the window may
  // well have closed in between.
  const windowOpen = (phone) => {
    const t = lastInbound[phone];
    return !!t && (now - new Date(t).getTime()) < 24 * 3600 * 1000;
  };

  let sent = 0, failed = 0, touched = false;

  for (const item of items) {
    if (item.status === "cancelled") continue;
    if (!item.when || new Date(item.when).getTime() > now) continue;
    if (item.repeat === "once" && item.status === "sent") continue;

    const isFreeText = item.kind === "text";
    const isMarketing = !isFreeText && item.category === "MARKETING";
    const results = [];

    for (const raw of (item.recipients || [])) {
      const phone = formatPhone(raw);
      if (!phone) continue;

      if (isMarketing) {
        if (optouts[phone]) { results.push({ phone, skipped: "opted out" }); continue; }
        const last = marketingLog[phone];
        if (last && (now - new Date(last).getTime()) / 86400000 < MARKETING_GAP_DAYS) {
          results.push({ phone, skipped: "messaged recently" });
          continue;
        }
      }

      try {
        if (isFreeText) {
          if (!windowOpen(phone)) {
            results.push({ phone, skipped: "24h window closed — they must message the business number first" });
            continue;
          }
          await sendText(phone, item.message || "");
        } else {
          await sendTemplate(phone, item.templateName, item.params || []);
          if (isMarketing) marketingLog[phone] = new Date().toISOString();
        }
        results.push({ phone, ok: true });
        sent++;
      } catch (e) {
        results.push({ phone, error: e.message });
        failed++;
      }
    }

    // Per-item outcome. Counting across the whole queue meant an item whose
    // every recipient was skipped still came out marked "sent" — silence with
    // no error, which is the worst possible failure mode.
    const okCount   = results.filter(r => r.ok).length;
    const errCount  = results.filter(r => r.error).length;
    const skipCount = results.filter(r => r.skipped).length;

    item.lastRun = new Date().toISOString();
    item.lastResult = results;
    item.lastError = results.filter(r => r.error).map(r => r.error)[0] || null;

    // A repeating item rolls its next run forward; a one-off is done.
    if (item.repeat && item.repeat !== "once") {
      item.when = nextRun(item.when, item.repeat);
      item.status = "pending";
    } else if (okCount > 0) {
      item.status = errCount || skipCount ? "partly sent" : "sent";
    } else if (skipCount > 0 && errCount === 0) {
      item.status = "skipped";
    } else {
      item.status = "failed";
    }
    if (!item.lastError && skipCount && !okCount) {
      item.lastError = results.filter(r => r.skipped).map(r => r.skipped)[0];
    }
    touched = true;
  }

  if (touched) {
    await kvPut("wa_scheduled", { scheduled: items });
    await kvPut("wa_marketing_log", marketingLog);
  }

  return json({ ok: true, checked: items.length, sent, failed });
};

// Schedule is declared in netlify.toml, not here — an in-file config export
// is only honoured for ES modules, and this file is CommonJS.

function nextRun(when, repeat) {
  const d = new Date(when);
  if (repeat === "daily") d.setDate(d.getDate() + 1);
  else if (repeat === "weekly") d.setDate(d.getDate() + 7);
  else if (repeat === "monthly") d.setMonth(d.getMonth() + 1);
  return d.toISOString();
}

function formatPhone(phone) {
  let p = String(phone || "").replace(/[^\d]/g, "");
  if (p.length === 10) p = "91" + p;           // bare Indian mobile
  if (p.length === 11 && p[0] === "0") p = "91" + p.slice(1);
  return p.length >= 11 ? p : "";
}

function sendText(to, message) {
  return waPost({
    messaging_product: "whatsapp",
    to,
    type: "text",
    text: { body: String(message) }
  });
}

function sendTemplate(to, name, params) {
  const components = params.length
    ? [{ type: "body", parameters: params.map(p => ({ type: "text", text: String(p) })) }]
    : [];
  return waPost({
    messaging_product: "whatsapp",
    to,
    type: "template",
    template: { name, language: { code: "en" }, components }
  });
}

function waPost(body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = https.request({
      hostname: "graph.facebook.com",
      path: "/v21.0/" + PHONE_NUMBER_ID + "/messages",
      method: "POST",
      headers: {
        "Authorization": "Bearer " + ACCESS_TOKEN,
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload)
      }
    }, (res) => {
      let data = "";
      res.on("data", c => data += c);
      res.on("end", () => {
        try {
          const j = JSON.parse(data);
          if (res.statusCode >= 300 || j.error) {
            const e = j.error || {};
            return reject(new Error("#" + (e.code || res.statusCode) + " " + (e.message || data.slice(0, 120))));
          }
          resolve(j);
        } catch (err) { reject(new Error("bad response: " + data.slice(0, 120))); }
      });
    });
    req.on("error", reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error("timeout")); });
    req.write(payload);
    req.end();
  });
}

function json(obj) {
  return { statusCode: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj) };
}

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
