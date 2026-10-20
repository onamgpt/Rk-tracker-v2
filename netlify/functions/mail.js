// Email out. Deliberately Netlify-native so notifications never depend on
// an Apps Script redeployment. Uses Resend if a key is present.
const https = require("https");

exports.handler = async (event) => {
  const h = {
    "Access-Control-Allow-Origin": "*",
    "Content-Type": "application/json",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS"
  };
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers: h, body: "" };

  const key  = process.env.RESEND_API_KEY;
  // No hardcoded fallback. A literal address here matches the MAIL_FROM value
  // and Netlify's secret scanner blocks the whole deploy over it.
  const from = process.env.MAIL_FROM;

  if (!key || !from) {
    // Not configured yet. Report it plainly rather than failing silently —
    // the caller treats mail as best-effort and the order still goes through.
    return { statusCode: 200, headers: h,
      body: JSON.stringify({ ok: false, skipped: true,
        reason: !key ? "RESEND_API_KEY not set" : "MAIL_FROM not set" }) };
  }

  let body = {};
  try { body = JSON.parse(event.body || "{}"); } catch (e) {}
  let { to, subject, html, text } = body;
  if (!to || !subject) {
    return { statusCode: 400, headers: h, body: JSON.stringify({ ok: false, error: "to and subject required" }) };
  }
  // Owner digest (Ravi, Oct 2026): every email meant for the owner from the tracker's own jobs is held and sent once a day
  // as one summary (owner-digest.js, 19:30 IST). Only internal calls (no HTTP headers) are held; body.direct bypasses it.
  if (!event.headers && !body.direct) {
    const OWNER = ["onamagarbathi@gmail.com"];
    const list = (Array.isArray(to) ? to : [to]).map((x) => String(x).trim()).filter(Boolean);
    const forOwner = list.filter((x) => OWNER.indexOf(x.toLowerCase()) >= 0);
    if (forOwner.length) {
      try {
        const db = require("./db.js");
        const call = async (b) => JSON.parse((await db.handler({ httpMethod: "POST", body: JSON.stringify(b) })).body || "{}");
        const cur = (await call({ action: "getPortfolio", user: "main", key: "owner_digest" })).data || { items: [] };
        cur.items = (cur.items || []).concat({ at: new Date().toISOString(), subject, html: html || "", text: text || "" }).slice(-80);
        await call({ action: "savePortfolio", user: "main", key: "owner_digest", data: cur });
        to = list.filter((x) => forOwner.indexOf(x) < 0);
        if (!to.length) return { statusCode: 200, headers: h, body: JSON.stringify({ ok: true, digested: true }) };
      } catch (e) { /* holding failed: send normally to everyone */ }
    }
  }

  const payload = JSON.stringify({
    from,
    to: Array.isArray(to) ? to : [to],
    subject,
    html: html || undefined,
    text: text || undefined
  });

  const send = () => new Promise((resolve) => {
    const req = https.request({
      hostname: "api.resend.com",
      path: "/emails",
      method: "POST",
      headers: {
        "Authorization": "Bearer " + key,
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload)
      }
    }, (res) => {
      let d = "";
      res.on("data", c => d += c);
      res.on("end", () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(d) }); }
        catch (e) { resolve({ status: res.statusCode, body: { raw: d } }); }
      });
    });
    req.on("error", e => resolve({ status: 0, body: { error: String(e) } }));
    req.setTimeout(15000, () => { req.destroy(); resolve({ status: 0, body: { error: "timeout" } }); });
    req.write(payload);
    req.end();
  });

  const r = await send();
  return {
    statusCode: 200,
    headers: h,
    body: JSON.stringify({ ok: r.status >= 200 && r.status < 300, status: r.status, result: r.body })
  };
};
