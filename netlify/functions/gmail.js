// Read-only Gmail access for the tracker (scope: gmail.readonly).
// Token is stored in Supabase (key "gmail_oauth"). Client ID/secret live in
// Netlify env: GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET.
const db = require("./db.js");
const call = async (b) => JSON.parse((await db.handler({ httpMethod: "POST", body: JSON.stringify(b) })).body || "{}");
const kvGet = async (k) => { const r = await call({ action: "getPortfolio", user: "main", key: k }); return r && r.data != null ? r.data : null; };
const kvSet = (k, d) => call({ action: "savePortfolio", user: "main", key: k, data: d });
const SCOPE = "https://www.googleapis.com/auth/gmail.readonly";
const SITE = () => (process.env.URL || "https://rk-tracker-v2.netlify.app").replace(/\/$/, "");
const REDIRECT = () => SITE() + "/.netlify/functions/gmail-auth";
async function accessToken() {
  const t = await kvGet("gmail_oauth");
  if (!t || !t.refresh) throw new Error("Gmail is not connected");
  const r = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: process.env.GMAIL_CLIENT_ID || "", client_secret: process.env.GMAIL_CLIENT_SECRET || "", refresh_token: t.refresh, grant_type: "refresh_token" }).toString() });
  const j = await r.json().catch(() => ({}));
  if (!j.access_token) throw new Error("Gmail sign-in expired — reconnect (" + (j.error_description || j.error || r.status) + ")");
  return j.access_token;
}
async function gget(path, tok) {
  const r = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/" + path, { headers: { Authorization: "Bearer " + tok } });
  const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error("Gmail " + r.status + ": " + ((j.error && j.error.message) || "")); return j;
}
function parts(p, out) { out = out || []; if (!p) return out; if (p.filename && p.body && p.body.attachmentId) out.push({ name: p.filename, type: p.mimeType, id: p.body.attachmentId, size: p.body.size }); (p.parts || []).forEach((x) => parts(x, out)); return out; }
const header = (m, n) => ((m.payload && m.payload.headers) || []).find((h) => h.name.toLowerCase() === n.toLowerCase())?.value || "";
function b64url(x) { return Buffer.from(String(x || "").replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"); }
// Plain text of a message (falls back to HTML with tags stripped)
function bodyText(p) {
  let plain = "", html = "";
  (function walk(x) { if (!x) return;
    if (x.mimeType === "text/plain" && x.body && x.body.data) plain += b64url(x.body.data) + "\n";
    else if (x.mimeType === "text/html" && x.body && x.body.data) html += b64url(x.body.data) + "\n";
    (x.parts || []).forEach(walk); })(p);
  if (plain.trim()) return plain;
  return html.replace(/<a [^>]*href="([^"]+)"[^>]*>/gi, " $1 ").replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&nbsp;/g, " ").replace(/\s+/g, " ");
}
// Search mail; returns [{id, subject, from, date, internalDate, body, attachments:[{name,type,id,size}]}]
async function search(q, max) {
  const tok = await accessToken();
  const list = await gget("messages?maxResults=" + (max || 10) + "&q=" + encodeURIComponent(q), tok);
  const out = [];
  for (const m of list.messages || []) {
    const full = await gget("messages/" + m.id + "?format=full", tok);
    out.push({ id: m.id, subject: header(full, "Subject"), from: header(full, "From"), date: header(full, "Date"), internalDate: Number(full.internalDate || 0),
      body: bodyText(full.payload).slice(0, 20000), attachments: parts(full.payload) });
  }
  return { tok, messages: out };
}
async function attachment(tok, msgId, attId) {
  const j = await gget("messages/" + msgId + "/attachments/" + attId, tok);
  return Buffer.from(String(j.data || "").replace(/-/g, "+").replace(/_/g, "/"), "base64");
}
module.exports = { kvGet, kvSet, SCOPE, REDIRECT, SITE, accessToken, search, attachment, gget };
