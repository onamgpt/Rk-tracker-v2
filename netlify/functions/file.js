// Opens a stored file: checks the link's signature, then redirects to a
// signed Supabase Storage URL that is valid for one hour.
const db = require("./db.js");
exports.handler = async (event) => {
  const q = event.queryStringParameters || {};
  const path = String(q.p || ""), sig = String(q.s || "");
  if (!path || path.indexOf("..") >= 0 || sig !== db.fileSig(path)) return { statusCode: 403, body: "Link not valid" };
  const SB = (process.env.SUPABASE_URL || "").replace(/\/$/, ""), KEY = process.env.SUPABASE_SERVICE_KEY || "";
  try {
    const r = await fetch(SB + "/storage/v1/object/sign/" + db.FILE_BUCKET + "/" + path.split("/").map(encodeURIComponent).join("/"), {
      method: "POST", headers: { apikey: KEY, Authorization: "Bearer " + KEY, "Content-Type": "application/json" }, body: JSON.stringify({ expiresIn: 3600 }) });
    const j = await r.json().catch(() => ({}));
    const signed = j.signedURL || j.signedUrl;
    if (!signed) return { statusCode: 404, body: "File not found" };
    return { statusCode: 302, headers: { Location: SB + "/storage/v1" + (signed.indexOf("/") === 0 ? "" : "/") + signed, "Cache-Control": "private, max-age=600" }, body: "" };
  } catch (e) { return { statusCode: 502, body: "Could not open file" }; }
};
