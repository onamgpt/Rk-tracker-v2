// Shared WhatsApp plumbing for the office number (9180457950).
//   people + roles · Supabase helpers · outbox (row per message, no lost writes)
//   · Telegram → WhatsApp mirror · Claude call · bridge key check
const crypto = require("crypto");
const SB = () => (process.env.SUPABASE_URL || "").replace(/\/$/, "");
const KEY = () => process.env.SUPABASE_SERVICE_KEY || "";
const SITE = () => (process.env.URL || "https://rk-tracker-v2.netlify.app").replace(/\/$/, "");

// owner:true = sees money, margins, attendance and Tally answers.
const PEOPLE = {
  ravi:       { name: "Ravi",          phone: "919845563633", owner: true,  tg: "8632288596" },
  ravi2:      { name: "Ravi",          phone: "918310368142", owner: true,  alias: "ravi" },
  brunda:     { name: "Brunda",        phone: "919886211325", owner: true,  tg: "6729590573" },
  tassmai:    { name: "Tassmai",       phone: "919900504401", owner: true },
  prakash:    { name: "Prakash",       phone: "919844725484", owner: false, tg: "6294256754" },
  virupaksha: { name: "Virupaksha",    phone: "919845807015", owner: false, tg: "8214343987" },
  maadhu:     { name: "Maadhu",        phone: "916364559047", owner: false },
  security:   { name: "Security",      phone: "919900537494", owner: false }
};
const ALIASES = { viru: "virupaksha", madhu: "maadhu", gate: "security", me: "ravi", rk: "ravi", ravikiran: "ravi", bru: "brunda", tass: "tassmai" };

function personByPhone(num) {
  const d = String(num || "").replace(/\D/g, "");
  for (const k of Object.keys(PEOPLE)) if (PEOPLE[k].phone === d) return Object.assign({ key: PEOPLE[k].alias || k }, PEOPLE[k]);
  return null;
}
function personKey(name) {
  const s = String(name || "").toLowerCase().trim().replace(/[^a-z0-9]/g, "");
  if (PEOPLE[s]) return PEOPLE[s].alias || s;
  if (ALIASES[s]) return ALIASES[s];
  for (const k of Object.keys(PEOPLE)) if (PEOPLE[k].name.toLowerCase().replace(/[^a-z]/g, "") === s) return PEOPLE[k].alias || k;
  return null;
}
function jidFor(to) {
  const t = String(to || "").trim();
  if (/@(c|g)\.us$/.test(t)) return t;
  const k = personKey(t);
  if (k) return PEOPLE[k].phone + "@c.us";
  let d = t.replace(/\D/g, "").replace(/^0+/, "");
  if (d.length === 10) d = "91" + d;
  return d.length >= 11 ? d + "@c.us" : null;
}

async function sb(method, path, body, extra) {
  const r = await fetch(SB() + path, { method, headers: Object.assign({ apikey: KEY(), Authorization: "Bearer " + KEY(), "Content-Type": "application/json" }, extra || {}),
    body: body === undefined ? undefined : JSON.stringify(body) });
  const t = await r.text();
  if (r.status >= 400) throw new Error("supabase " + r.status + " " + t.slice(0, 200));
  try { return t ? JSON.parse(t) : null; } catch (e) { return t; }
}
const kvGet = async (k) => { const r = await sb("GET", "/rest/v1/kv?owner=eq.main&k=eq.pf_" + encodeURIComponent(k) + "&select=v"); return r && r[0] ? r[0].v : null; };
const kvSet = (k, v) => sb("POST", "/rest/v1/kv?on_conflict=owner,k", { owner: "main", k: "pf_" + k, v }, { Prefer: "resolution=merge-duplicates,return=minimal" });

let _secret = null;
async function bridgeSecret() {
  if (_secret) return _secret;
  const r = await sb("GET", "/rest/v1/wa_bridge_secret?id=eq.1&select=secret");
  _secret = (r && r[0] && r[0].secret) || "";
  return _secret;
}
async function bridgeOk(event) {
  const h = event.headers || {};
  const got = String(h["x-bridge-key"] || h["X-Bridge-Key"] || (event.queryStringParameters || {}).k || "");
  const want = await bridgeSecret();
  if (!want || got.length !== want.length) return false;
  return crypto.timingSafeEqual(Buffer.from(got), Buffer.from(want));
}

const clean = (t) => String(t == null ? "" : t).replace(/<br\s*\/?>/gi, "\n").replace(/<\/?b>/gi, "*").replace(/<[^>]+>/g, "")
  .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').trim();

// Queue one message per recipient. to: person key, phone or jid (or a list).
async function send(to, text, opt) {
  opt = opt || {};
  const list = Array.isArray(to) ? to : [to];
  const seen = new Set(), rows = [];
  for (const t of list) { const j = jidFor(t); if (j && !seen.has(j)) { seen.add(j); rows.push({ to_jid: j, body: clean(text).slice(0, 3800), kind: opt.kind || "msg", task_id: opt.taskId || null }); } }
  if (!rows.length || !rows[0].body) return [];
  try { return (await sb("POST", "/rest/v1/wa_outbox", rows, { Prefer: "return=representation" })) || []; } catch (e) { return []; }
}

// Everything that goes out on Telegram also goes out on WhatsApp.
// Known personal chats map to that person; groups map to Ravi.
async function mirrorTg(chatIds, text) {
  try {
    const keys = new Set();
    for (const id of chatIds || []) {
      const s = String(id);
      const k = Object.keys(PEOPLE).find((x) => PEOPLE[x].tg === s);
      if (k) keys.add(k); else if (s.indexOf("-") === 0) keys.add("ravi");
    }
    if (keys.size) await send([...keys], text, { kind: "mirror" });
  } catch (e) { /* never break the Telegram leg */ }
}

async function claude(content, system, maxTokens) {
  let err = null;
  for (const model of ["claude-sonnet-5-5", "claude-haiku-4-5-20251001"]) {
    try {
      const r = await fetch("https://api.anthropic.com/v1/messages", { method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": process.env.ANTHROPIC_API_KEY || "", "anthropic-version": "2023-06-01" },
        body: JSON.stringify({ model, max_tokens: maxTokens || 1500, system, messages: [{ role: "user", content }] }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error((j.error && j.error.message) || ("AI " + r.status));
      const t = (j.content || []).filter((c) => c.type === "text").map((c) => c.text).join("\n").trim();
      if (t) return t;
    } catch (e) { err = e; }
  }
  throw err || new Error("no answer");
}
function parseJSON(t) {
  const s = String(t || "").replace(/```json|```/g, "");
  const a = s.indexOf("{"), b = s.lastIndexOf("}");
  return JSON.parse(a >= 0 ? s.slice(a, b + 1) : s);
}

const istNow = () => new Date(Date.now() + 5.5 * 3600e3);
const istDate = () => istNow().toISOString().slice(0, 10);
const istHour = () => istNow().getUTCHours() + istNow().getUTCMinutes() / 60;
function fmtDue(iso) {
  if (!iso) return "no date";
  const d = new Date(new Date(iso).getTime() + 5.5 * 3600e3);
  const day = d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
  const hh = d.getUTCHours(), mm = d.getUTCMinutes();
  return day + " " + ((hh % 12) || 12) + (mm ? ":" + String(mm).padStart(2, "0") : "") + (hh < 12 ? "am" : "pm");
}

module.exports = { PEOPLE, personByPhone, personKey, jidFor, sb, kvGet, kvSet, bridgeOk, bridgeSecret, send, mirrorTg, claude, parseJSON, clean, istNow, istDate, istHour, fmtDue, SITE };
