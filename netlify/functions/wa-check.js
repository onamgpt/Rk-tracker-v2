// Reports why the WhatsApp scheduler is or isn't sending. Deliberately NOT a
// scheduled function, so it can be opened in a browser — Netlify blocks direct
// HTTP calls to scheduled ones, which makes them impossible to inspect.
//
//   /.netlify/functions/wa-check          -> report only
//   /.netlify/functions/wa-check?run=1    -> also drain the queue now

const https = require("https");

const ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;
const PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

exports.handler = async (event) => {
  const out = [];
  const reply = () => ({
    statusCode: 200,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
    body: out.join("\n")
  });

  out.push("WhatsApp scheduler check (tracker site)");
  out.push("=======================================");
  out.push("");
  out.push("WHATSAPP_ACCESS_TOKEN     " + (ACCESS_TOKEN ? "set" : "MISSING"));
  out.push("WHATSAPP_PHONE_NUMBER_ID  " + (PHONE_NUMBER_ID || "MISSING"));
  out.push("SUPABASE_URL              " + (SUPABASE_URL ? "set" : "MISSING"));
  out.push("SUPABASE_SERVICE_KEY      " + (SERVICE_KEY ? "set" : "MISSING"));
  out.push("");

  if (!ACCESS_TOKEN || !PHONE_NUMBER_ID) {
    out.push("PROBLEM FOUND");
    out.push("The scheduler exits immediately when either of these is missing,");
    out.push("so queued items stay 'pending' forever with no error shown.");
    out.push("");
    out.push("FIX: add the missing variable(s) to THIS site (rk-tracker-v2) in");
    out.push("Netlify env vars. The shop site having them does not help — the");
    out.push("scheduler runs here.");
    return reply();
  }

  if (!SUPABASE_URL || !SERVICE_KEY) {
    out.push("PROBLEM FOUND: the scheduler cannot read the queue without these.");
    return reply();
  }

  const store = await kvGet("wa_scheduled");
  const items = Array.isArray(store.scheduled) ? store.scheduled : [];
  const inbound = await kvGet("wa_last_inbound");
  const now = Date.now();

  out.push("Queue: " + items.length + " item(s)");
  out.push("Now:   " + new Date().toISOString() + "  (UTC)");
  out.push("");

  for (const it of items) {
    const due = new Date(it.when).getTime();
    const mins = Math.round((now - due) / 60000);
    out.push("- " + (it.kind === "text" ? "free text" : "template " + it.templateName));
    out.push("  when:      " + it.when + (mins >= 0 ? "  (due " + mins + " min ago)" : "  (in " + -mins + " min)"));
    out.push("  status:    " + (it.status || "?") + (it.lastError ? "  error: " + it.lastError : ""));
    out.push("  to:        " + (it.recipients || []).join(", "));
    if (it.kind === "text") {
      for (const raw of (it.recipients || [])) {
        const p = norm(raw);
        const t = inbound[p];
        const open = t && (now - new Date(t).getTime()) < 86400000;
        out.push("  window:    " + p + " " + (open ? "OPEN" : "CLOSED — they must message the business number first"));
      }
    }
    out.push("");
  }

  const due = items.filter(i => i.status !== "cancelled" && i.when &&
    new Date(i.when).getTime() <= now && !(i.repeat === "once" && i.status === "sent"));
  const seen = Object.keys(inbound);
  out.push("Numbers that have messaged the business number: " +
           (seen.length ? seen.join(", ") : "NONE RECORDED"));
  if (!seen.length) {
    out.push("  If this is empty, the webhook is not recording inbound messages.");
    out.push("  Free text cannot work until it does.");
  }
  out.push("");
  out.push(due.length + " item(s) are due and should have been sent.");
  out.push("");

  if (!(event.queryStringParameters || {}).run) {
    out.push("Add ?run=1 to this URL to drain the queue now and see what happens.");
    return reply();
  }

  out.push("Running now...");
  out.push("");
  let sent = 0;
  for (const it of due) {
    for (const raw of (it.recipients || [])) {
      const phone = String(raw).replace(/[^\d]/g, "");
      try {
        if (it.kind === "text") {
          const t = inbound[phone];
          if (!t || (now - new Date(t).getTime()) >= 86400000) {
            out.push("  " + phone + ": skipped, 24h window closed");
            continue;
          }
          await waPost({ messaging_product: "whatsapp", to: phone, type: "text",
                         text: { body: String(it.message || "") } });
        } else {
          const params = it.params || [];
          await waPost({
            messaging_product: "whatsapp", to: phone, type: "template",
            template: {
              name: it.templateName, language: { code: "en" },
              components: params.length
                ? [{ type: "body", parameters: params.map(p => ({ type: "text", text: String(p) })) }]
                : []
            }
          });
        }
        out.push("  " + phone + ": SENT");
        sent++;
        it.status = "sent";
        it.lastRun = new Date().toISOString();
      } catch (e) {
        out.push("  " + phone + ": FAILED — " + e.message);
        it.status = "failed";
        it.lastError = e.message;
      }
    }
  }
  if (due.length) await kvPut("wa_scheduled", { scheduled: items });
  out.push("");
  out.push("Sent " + sent + ". If these arrived, the code is fine and only the");
  out.push("15-minute trigger needs looking at.");
  return reply();
};

function norm(phone) {
  let p = String(phone || "").replace(/[^\d]/g, "");
  if (p.length === 10) p = "91" + p;
  if (p.length === 11 && p[0] === "0") p = "91" + p.slice(1);
  return p;
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
      let d = "";
      res.on("data", c => d += c);
      res.on("end", () => {
        try {
          const j = JSON.parse(d);
          if (res.statusCode >= 300 || j.error) {
            const e = j.error || {};
            return reject(new Error("#" + (e.code || res.statusCode) + " " + (e.message || d.slice(0, 100))));
          }
          resolve(j);
        } catch (err) { reject(new Error("bad response: " + d.slice(0, 100))); }
      });
    });
    req.on("error", reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error("timeout")); });
    req.write(payload);
    req.end();
  });
}

function kvGet(key) {
  return new Promise((resolve) => {
    const u = new URL(SUPABASE_URL + "/rest/v1/kv?owner=eq.main&k=eq." + encodeURIComponent(key) + "&select=v");
    const req = https.request({
      hostname: u.hostname, path: u.pathname + u.search, method: "GET",
      headers: { "apikey": SERVICE_KEY, "Authorization": "Bearer " + SERVICE_KEY }
    }, (res) => {
      let d = "";
      res.on("data", c => d += c);
      res.on("end", () => {
        try { const j = JSON.parse(d); resolve((Array.isArray(j) && j[0] && j[0].v) ? j[0].v : {}); }
        catch (e) { resolve({}); }
      });
    });
    req.on("error", () => resolve({}));
    req.setTimeout(10000, () => { req.destroy(); resolve({}); });
    req.end();
  });
}

function kvPut(key, value) {
  return new Promise((resolve) => {
    const u = new URL(SUPABASE_URL + "/rest/v1/kv?on_conflict=owner,k");
    const b = JSON.stringify({ owner: "main", k: key, v: value });
    const req = https.request({
      hostname: u.hostname, path: u.pathname + u.search, method: "POST",
      headers: {
        "apikey": SERVICE_KEY, "Authorization": "Bearer " + SERVICE_KEY,
        "Content-Type": "application/json", "Prefer": "resolution=merge-duplicates",
        "Content-Length": Buffer.byteLength(b)
      }
    }, (res) => { res.on("data", () => {}); res.on("end", () => resolve(true)); });
    req.on("error", () => resolve(false));
    req.setTimeout(10000, () => { req.destroy(); resolve(false); });
    req.write(b); req.end();
  });
}
