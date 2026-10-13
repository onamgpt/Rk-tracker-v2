// Connect / check / disconnect the tracker's read-only Gmail access.
//  POST {action:"start"|"status"|"disconnect", pin}  (owner PIN)
//  GET  ?code=...&state=...   (Google sends the user back here)
const crypto = require("crypto");
const G = require("./gmail.js");
const H = { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json", "Access-Control-Allow-Headers": "Content-Type" };
const OK = (o) => ({ statusCode: 200, headers: H, body: JSON.stringify(o) });
const hash = (p) => crypto.createHash("sha256").update("rkpin:" + p).digest("hex");
const sign = (s) => crypto.createHmac("sha256", process.env.SUPABASE_SERVICE_KEY || "").update("gmail:" + s).digest("hex").slice(0, 24);
const page = (title, msg, ok) => ({ statusCode: 200, headers: { "Content-Type": "text/html; charset=utf-8" },
  body: '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><body style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:480px;margin:15vh auto;padding:20px;text-align:center"><div style="font-size:44px">' + (ok ? "✅" : "⚠️") + '</div><h2>' + title + '</h2><p style="color:#555">' + msg + '</p><p><a href="/tally/" style="color:#14532d;font-weight:700">Back to Tally</a></p></body>' });
exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers: H, body: "" };
  const q = event.queryStringParameters || {};
  if (event.httpMethod === "GET" && (q.code || q.error)) {
    if (q.error) return page("Not connected", "Google said: " + String(q.error).replace(/[<>]/g, ""), false);
    const [ts, sig] = String(q.state || "").split(".");
    if (!ts || sig !== sign(ts) || Date.now() - Number(ts) > 20 * 60e3) return page("Link expired", "Please start again from the Tally page.", false);
    const r = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ code: q.code, client_id: process.env.GMAIL_CLIENT_ID || "", client_secret: process.env.GMAIL_CLIENT_SECRET || "", redirect_uri: G.REDIRECT(), grant_type: "authorization_code" }).toString() });
    const j = await r.json().catch(() => ({}));
    if (!j.refresh_token) return page("Not connected", "Google didn't return a long-term key (" + String(j.error_description || j.error || "no refresh token").replace(/[<>]/g, "") + "). Try again.", false);
    let email = "";
    try { const pr = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/profile", { headers: { Authorization: "Bearer " + j.access_token } }); email = (await pr.json()).emailAddress || ""; } catch (e) {}
    await G.kvSet("gmail_oauth", { refresh: j.refresh_token, email, scope: j.scope || G.SCOPE, at: new Date().toISOString() });
    return page("Gmail connected", "Read-only access for " + email + ". The tracker can now pick up Maadhu's backup emails each morning.", true);
  }
  let b = {}; try { b = JSON.parse(event.body || "{}"); } catch (e) {}
  const pins = (await G.kvGet("user_pins")) || {};
  if (!pins.main || !b.pin || pins.main !== hash(String(b.pin))) return OK({ error: "pin" });
  if (b.action === "start") {
    if (!process.env.GMAIL_CLIENT_ID || !process.env.GMAIL_CLIENT_SECRET) return OK({ error: "setup", message: "GMAIL_CLIENT_ID / GMAIL_CLIENT_SECRET are not set in Netlify yet." });
    const ts = String(Date.now());
    const url = "https://accounts.google.com/o/oauth2/v2/auth?" + new URLSearchParams({ client_id: process.env.GMAIL_CLIENT_ID, redirect_uri: G.REDIRECT(), response_type: "code",
      scope: G.SCOPE, access_type: "offline", prompt: "consent", include_granted_scopes: "true", state: ts + "." + sign(ts) }).toString();
    return OK({ ok: true, url, redirect: G.REDIRECT() });
  }
  if (b.action === "status") {
    const t = await G.kvGet("gmail_oauth");
    if (!t || !t.refresh) return OK({ ok: true, connected: false, redirect: G.REDIRECT(), configured: !!(process.env.GMAIL_CLIENT_ID && process.env.GMAIL_CLIENT_SECRET) });
    try { await G.accessToken(); return OK({ ok: true, connected: true, email: t.email, at: t.at }); }
    catch (e) { return OK({ ok: true, connected: false, expired: true, error: e.message, email: t.email }); }
  }
  if (b.action === "disconnect") {
    const t = await G.kvGet("gmail_oauth");
    if (t && t.refresh) { try { await fetch("https://oauth2.googleapis.com/revoke?token=" + encodeURIComponent(t.refresh), { method: "POST" }); } catch (e) {} }
    await G.kvSet("gmail_oauth", null); return OK({ ok: true });
  }
  return OK({ error: "unknown action" });
};
