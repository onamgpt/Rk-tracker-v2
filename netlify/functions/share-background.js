// Second half of the Share Sheet: uploads parked files to Drive (same path the
// tracker uses), then saves the Quick Notes entry with the Drive links.
const db = require("./db.js");
const smart = require("./smartnote.js");
const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || "";
const sbH = { apikey: SERVICE_KEY, Authorization: "Bearer " + SERVICE_KEY, "Content-Type": "application/json" };
const call = async (b) => JSON.parse((await db.handler({ httpMethod: "POST", body: JSON.stringify(b) })).body || "{}");

exports.handler = async (event) => {
  let b = {}; try { b = JSON.parse(event.body || "{}"); } catch (e) {}
  if (!process.env.SHARE_KEY || b.key !== process.env.SHARE_KEY || !b.k) return;
  const kv = SUPABASE_URL + "/rest/v1/kv?owner=eq._share&k=eq." + encodeURIComponent(b.k);
  const r = await fetch(kv + "&select=v", { headers: sbH });
  const rows = await r.json().catch(() => []);
  const job = rows && rows[0] && rows[0].v;
  if (!job) return;
  const { user, entry, files } = job;

  const failed = [], atts = [];
  let ocr = "";
  for (const f of files) {
    let res = null;
    for (let attempt = 0; attempt < 2 && !res; attempt++) {
      try {
        const u = await call({ action: "uploadFile", user, file: { name: f.name, type: f.type, data: "data:" + f.type + ";base64," + f.b64 } });
        const url = u && (u.url || u.link || (u.data && String(u.data).indexOf("http") === 0 ? u.data : null));
        if (url) res = { name: f.name, type: "drive", data: url, driveId: u.id || u.driveId || "" };
      } catch (e) {}
    }
    if (res) atts.push(res); else failed.push(f.name);
    // Read the text in shared photos (bills, cards, screenshots) so it's searchable.
    if (/^image\//.test(f.type)) { const t = await smart.ocrImage(f.b64, f.type); if (t) ocr += (ocr ? "\n\n" : "") + t; }
  }
  let text = entry.notes || "";
  if (failed.length) text = (text ? text + "\n\n" : "") + "⚠️ Could not upload: " + failed.join(", ");

  let rr = null;
  try { rr = await smart.route({ user, text, attachments: atts, ocr }); } catch (e) {}
  if (!rr || !rr.ok) {
    entry.attachments = atts; entry.notes = text + (ocr ? "\n\n🔍 Text from photo:\n" + ocr : "");
    if (atts[0]) { entry.link = atts[0].data; entry.linkLabel = "📎 Attachment"; }
    const s = await call({ action: "save", user, entry });
    rr = s && s.ok ? { ok: true, mode: "new", category: "Quick Notes", title: entry.title } : null;
  }
  if (rr && rr.ok) {
    await fetch(kv, { method: "DELETE", headers: sbH });
    try {
      const base = process.env.URL || "https://rk-tracker-v2.netlify.app";
      if (user === "main") await fetch(base + "/.netlify/functions/telegram", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "send", chatIds: ["8632288596"], message: "📥 " + require("./share.js").describe(rr) + (atts.length ? " · 📎 " + atts.length : "") }) });
    } catch (e) {}
  }
};