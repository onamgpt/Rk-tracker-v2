// Second half of the Share Sheet: uploads parked files to Drive (same path the
// tracker uses), then saves the Quick Notes entry with the Drive links.
const db = require("./db.js");
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

  const failed = [];
  for (const f of files) {
    let res = null;
    for (let attempt = 0; attempt < 2 && !res; attempt++) {
      try {
        const u = await call({ action: "uploadFile", user, file: { name: f.name, type: f.type, data: "data:" + f.type + ";base64," + f.b64 } });
        const url = u && (u.url || u.link || (u.data && String(u.data).indexOf("http") === 0 ? u.data : null));
        if (url) res = { name: f.name, type: "drive", data: url, driveId: u.id || u.driveId || "" };
      } catch (e) {}
    }
    if (res) entry.attachments.push(res); else failed.push(f.name);
  }
  if (entry.attachments[0]) {
    entry.link = entry.attachments[0].data;
    entry.linkLabel = /^image\//.test(files[0].type) ? "📎 Photo" : "📎 File";
  }
  if (failed.length) entry.notes = (entry.notes ? entry.notes + "\n\n" : "") + "⚠️ Could not upload: " + failed.join(", ");

  const s = await call({ action: "save", user, entry });
  if (s && s.ok) await fetch(kv, { method: "DELETE", headers: sbH });
};
