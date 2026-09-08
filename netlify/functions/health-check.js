// Weekly credential health check.
//
// Every integration in this app fails silently: a revoked Resend key, an
// expired Apps Script refresh token and a dead WhatsApp token all look
// identical to "nothing happened". This actively exercises each credential
// and reports on Telegram ONLY when something is broken, so a message in the
// chat always means action is needed. Silence means everything passed.
//
// Read-only: nothing is sent to customers, nothing is written anywhere.
// Also callable over HTTP for an on-demand check (it is scheduled, so Netlify
// blocks direct invocation — use ?run=1 through the scheduled run instead).

const https = require("https");

const ALERT_CHAT = "8632288596";

function req(opts, body) {
  return new Promise((resolve) => {
    const r = https.request(opts, (res) => {
      let d = "";
      res.on("data", (c) => { if (d.length < 2000) d += c; });
      res.on("end", () => resolve({ status: res.statusCode, body: d }));
    });
    r.on("error", (e) => resolve({ status: 0, body: String(e.message) }));
    r.setTimeout(12000, () => { r.destroy(); resolve({ status: 0, body: "timed out" }); });
    if (body) r.write(body);
    r.end();
  });
}
const get = (host, path, headers) => req({ hostname: host, path, method: "GET", headers: headers || {} });

function short(s, n) {
  return String(s || "").replace(/\s+/g, " ").slice(0, n || 120);
}

// Each check returns { name, ok, detail }. A check that cannot run because a
// variable is absent is a failure, not a pass — a missing key breaks the
// feature just as thoroughly as a wrong one.
async function checkTelegram() {
  const t = process.env.TELEGRAM_BOT_TOKEN;
  if (!t) return { name: "Telegram bot", ok: false, detail: "TELEGRAM_BOT_TOKEN not set" };
  const r = await get("api.telegram.org", "/bot" + t + "/getMe");
  try {
    const j = JSON.parse(r.body);
    return j.ok
      ? { name: "Telegram bot", ok: true, detail: "@" + (j.result && j.result.username) }
      : { name: "Telegram bot", ok: false, detail: short(j.description) };
  } catch (e) { return { name: "Telegram bot", ok: false, detail: "HTTP " + r.status }; }
}

async function checkResend() {
  const k = process.env.RESEND_API_KEY;
  if (!k) return { name: "Resend (email)", ok: false, detail: "RESEND_API_KEY not set" };
  // Listing domains validates the key without sending anything.
  const r = await get("api.resend.com", "/domains", { Authorization: "Bearer " + k });
  if (r.status === 401 || r.status === 403) return { name: "Resend (email)", ok: false, detail: "key rejected: " + short(r.body, 90) };
  if (r.status >= 300) return { name: "Resend (email)", ok: false, detail: "HTTP " + r.status + " " + short(r.body, 80) };
  // Confirm the sending domain is still verified, not just that the key works.
  const from = process.env.MAIL_FROM || "";
  const dom = from.split("@")[1] || "";
  let note = "key ok";
  try {
    const j = JSON.parse(r.body);
    const list = j.data || j || [];
    const hit = (Array.isArray(list) ? list : []).find(d => d.name === dom);
    if (dom && hit && hit.status !== "verified") {
      return { name: "Resend (email)", ok: false, detail: dom + " is " + hit.status + ", not verified" };
    }
    if (dom && hit) note = dom + " verified";
  } catch (e) {}
  return { name: "Resend (email)", ok: true, detail: note };
}

async function checkWhatsApp() {
  const t = process.env.WHATSAPP_ACCESS_TOKEN;
  const id = process.env.WHATSAPP_PHONE_NUMBER_ID;
  if (!t) return { name: "WhatsApp", ok: false, detail: "WHATSAPP_ACCESS_TOKEN not set" };
  if (!id) return { name: "WhatsApp", ok: false, detail: "WHATSAPP_PHONE_NUMBER_ID not set" };
  const r = await get("graph.facebook.com", "/v21.0/" + id + "?fields=display_phone_number",
    { Authorization: "Bearer " + t });
  try {
    const j = JSON.parse(r.body);
    if (j.error) return { name: "WhatsApp", ok: false, detail: short(j.error.message, 110) };
    return { name: "WhatsApp", ok: true, detail: j.display_phone_number || "token valid" };
  } catch (e) { return { name: "WhatsApp", ok: false, detail: "HTTP " + r.status }; }
}

async function checkSupabase() {
  const u = (process.env.SUPABASE_URL || "").replace(/\/$/, "");
  const k = process.env.SUPABASE_SERVICE_KEY;
  if (!u || !k) return { name: "Supabase", ok: false, detail: "SUPABASE_URL or SERVICE_KEY not set" };
  const host = u.replace(/^https?:\/\//, "");
  const r = await get(host, "/rest/v1/kv?select=k&limit=1", { apikey: k, Authorization: "Bearer " + k });
  if (r.status >= 300 || r.status === 0) return { name: "Supabase", ok: false, detail: "HTTP " + r.status + " " + short(r.body, 80) };
  return { name: "Supabase", ok: true, detail: "reachable" };
}

async function checkGitHub() {
  const t = process.env.GITHUB_TOKEN;
  if (!t) return { name: "GitHub token", ok: false, detail: "GITHUB_TOKEN not set" };
  const r = await get("api.github.com", "/rate_limit",
    { Authorization: "Bearer " + t, "User-Agent": "rk-health", Accept: "application/vnd.github+json" });
  if (r.status === 401) return { name: "GitHub token", ok: false, detail: "token rejected or revoked" };
  if (r.status >= 300) return { name: "GitHub token", ok: false, detail: "HTTP " + r.status };
  return { name: "GitHub token", ok: true, detail: "valid" };
}

async function checkAppsScript() {
  // The refresh token is the part that silently expires (7 days while the
  // OAuth consent screen is still in Testing), so exchange it for real.
  const rt = process.env.GOOGLE_APPS_SCRIPT_REFRESH_TOKEN;
  const cid = process.env.GOOGLE_OAUTH_CLIENT_ID || process.env.Google_oauth_client_id || process.env.google_oauth_client_id;
  const cs = process.env.GOOGLE_OAUTH_CLIENT_SECRET || process.env.Google_oauth_client_secret || process.env.google_oauth_client_secret;
  if (!rt || !cid || !cs) return { name: "Apps Script (Gmail/Drive/GST)", ok: false, detail: "refresh token or OAuth client not set" };
  const form = "client_id=" + encodeURIComponent(cid) +
    "&client_secret=" + encodeURIComponent(cs) +
    "&refresh_token=" + encodeURIComponent(rt) +
    "&grant_type=refresh_token";
  const r = await req({
    hostname: "oauth2.googleapis.com", path: "/token", method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "Content-Length": Buffer.byteLength(form) }
  }, form);
  try {
    const j = JSON.parse(r.body);
    if (j.access_token) return { name: "Apps Script (Gmail/Drive/GST)", ok: true, detail: "refresh token valid" };
    return { name: "Apps Script (Gmail/Drive/GST)", ok: false, detail: short(j.error_description || j.error, 110) };
  } catch (e) { return { name: "Apps Script (Gmail/Drive/GST)", ok: false, detail: "HTTP " + r.status }; }
}

async function checkAnthropic() {
  const k = process.env.ANTHROPIC_API_KEY;
  if (!k) return { name: "Anthropic (AI features)", ok: false, detail: "ANTHROPIC_API_KEY not set" };
  const body = JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: 1, messages: [{ role: "user", content: "hi" }] });
  const r = await req({
    hostname: "api.anthropic.com", path: "/v1/messages", method: "POST",
    headers: { "x-api-key": k, "anthropic-version": "2023-06-01", "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) }
  }, body);
  if (r.status === 401 || r.status === 403) return { name: "Anthropic (AI features)", ok: false, detail: "key rejected" };
  // A 400 still proves the key authenticated, so only auth failures count.
  if (r.status === 0) return { name: "Anthropic (AI features)", ok: false, detail: short(r.body, 80) };
  return { name: "Anthropic (AI features)", ok: true, detail: "key valid" };
}

function tg(token, text) {
  const body = JSON.stringify({ chat_id: ALERT_CHAT, text: text });
  return req({
    hostname: "api.telegram.org", path: "/bot" + token + "/sendMessage", method: "POST",
    headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) }
  }, body);
}

exports.handler = async () => {
  const results = await Promise.all([
    checkTelegram(), checkResend(), checkWhatsApp(), checkSupabase(),
    checkGitHub(), checkAppsScript(), checkAnthropic()
  ]);

  const bad = results.filter(r => !r.ok);

  // Only speak up when something is wrong. A weekly "all fine" message trains
  // you to ignore it, and then the one that matters gets ignored too.
  const BOT = process.env.TELEGRAM_BOT_TOKEN;
  if (bad.length && BOT) {
    const lines = bad.map(b => "\u274c " + b.name + "\n    " + b.detail);
    await tg(BOT, "\u26a0\ufe0f Health check found " + bad.length + " problem" +
      (bad.length > 1 ? "s" : "") + ":\n\n" + lines.join("\n\n") +
      "\n\nThe rest passed. Nothing else is sending alerts for these.");
  }

  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      checkedAt: new Date().toISOString(),
      failing: bad.length,
      results: results
    }, null, 2)
  };
};
