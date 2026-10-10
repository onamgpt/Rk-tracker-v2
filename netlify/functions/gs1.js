// GS1 DataKart — read, create (as DRAFT by default) and update Onam's products.
// Owner-only: every call needs Ravi's tracker PIN. The GS1 token lives only in
// the GS1_API_TOKEN environment variable, never in the page.
const crypto = require("crypto");
const db = require("./db.js");
const H = { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json", "Access-Control-Allow-Headers": "Content-Type" };
const OK = (o) => ({ statusCode: 200, headers: H, body: JSON.stringify(o) });
const call = async (b) => JSON.parse((await db.handler({ httpMethod: "POST", body: JSON.stringify(b) })).body || "{}");
const kvGet = async (k) => { const r = await call({ action: "getPortfolio", user: "main", key: k }); return r && r.data != null ? r.data : null; };
const kvSet = (k, d) => call({ action: "savePortfolio", user: "main", key: k, data: d });
const hash = (p) => crypto.createHash("sha256").update("rkpin:" + p).digest("hex");
const BASE = "https://api.gs1datakart.org";
const GCP = "8901226";

let bearerStyle = null; // "Bearer <t>" or raw <t> — learned on first call
async function gs1(method, path, body, query) {
  const tok = (process.env.GS1_API_TOKEN || "").trim();
  if (!tok) return { ok: false, status: 0, error: "GS1_API_TOKEN is not set in Netlify" };
  const qs = query ? "?" + Object.entries(query).filter(([, v]) => v !== undefined && v !== "").map(([k, v]) => encodeURIComponent(k) + "=" + encodeURIComponent(v)).join("&") : "";
  const tryOnce = async (style) => {
    const r = await fetch(BASE + path + qs, { method, headers: { "Content-Type": "application/json", Accept: "application/json", Authorization: style === "raw" ? tok : "Bearer " + tok }, body: body ? JSON.stringify(body) : undefined });
    const ct = r.headers.get("content-type") || "";
    if (/json/.test(ct)) { const j = await r.json().catch(() => null); return { ok: r.ok, status: r.status, json: j }; }
    if (/image|pdf|octet|zip/.test(ct)) { const b = Buffer.from(await r.arrayBuffer()); return { ok: r.ok, status: r.status, file: { type: ct, data: b.toString("base64") } }; }
    return { ok: r.ok, status: r.status, text: (await r.text()).slice(0, 2000) };
  };
  let res = await tryOnce(bearerStyle || "bearer");
  if (res.status === 401 && !bearerStyle) { const alt = await tryOnce("raw"); if (alt.status !== 401) { bearerStyle = "raw"; return alt; } }
  if (res.status !== 401 && !bearerStyle) bearerStyle = "bearer";
  return res;
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers: H, body: "" };
  let b = {}; try { b = JSON.parse(event.body || "{}"); } catch (e) { return OK({ error: "bad request" }); }
  const pins = (await kvGet("user_pins")) || {};
  if (!pins.main) return OK({ error: "nopin" });
  if (!b.pin || pins.main !== hash(String(b.pin))) return OK({ error: "pin" });
  try {
    switch (b.action) {
      case "list": {   // all Onam products in DataKart — every page
        let all = [], page = 1, total = 1, first = null;
        do {
          const r = await gs1("POST", "/console/products", { gcp: [GCP], page });
          if (!r.ok) return OK({ ok: false, status: r.status, data: r.json || r.text || r.error });
          first = first || r.json;
          const j = r.json || {}; all = all.concat(j.items || []);
          total = (j.pageInfo && j.pageInfo.totalPage) || 1; page++;
        } while (page <= total && page <= 20);
        return OK({ ok: true, status: 200, data: { items: all, pageInfo: first && first.pageInfo } });
      }
      case "details": {
        const r = await gs1("POST", "/console/products/details/bulk", { gtins: (b.gtins || []).slice(0, 25).map(String) });
        return OK({ ok: r.ok, status: r.status, data: r.json || r.text || r.error });
      }
      case "categories": {
        const r = await gs1("GET", "/console/category", null, b.category_id ? { category_id: b.category_id } : null);
        return OK({ ok: r.ok, status: r.status, data: r.json || r.text || r.error });
      }
      case "attributes": {
        const r = await gs1("GET", "/console/products/attributes", null, { category: b.category, sub_category: b.sub_category });
        return OK({ ok: r.ok, status: r.status, data: r.json || r.text || r.error });
      }
      case "hscodes": {
        const r = await gs1("GET", "/console/products/hscodes", null, { search: b.search || "3307", limit: 20 });
        return OK({ ok: r.ok, status: r.status, data: r.json || r.text || r.error });
      }
      case "validate": {
        const r = await gs1("GET", "/console/gtin/validate", null, { gtin: b.gtin });
        return OK({ ok: r.ok, status: r.status, data: r.json || r.text || r.error });
      }
      case "create": {   // DRAFT unless Ravi explicitly asked to submit
        const list = (b.products || []).slice(0, 25).map(p => Object.assign({}, p, { gcp: GCP, status: b.submit === true ? "ACTIVE" : "draft" }));
        if (!list.length) return OK({ error: "no products" });
        const r = await gs1("POST", "/console/products/create/bulk", list);
        const log = (await kvGet("gs1_log")) || [];
        log.unshift({ at: new Date().toISOString(), action: b.submit === true ? "create+submit" : "create draft", gtins: list.map(p => p.gtin), status: r.status, ok: r.ok, result: r.json || r.text });
        await kvSet("gs1_log", log.slice(0, 100));
        return OK({ ok: r.ok, status: r.status, data: r.json || r.text || r.error });
      }
      case "update": {
        const list = (b.products || []).slice(0, 25).map(p => { const q = Object.assign({}, p); delete q.product_name; delete q.brand; delete q.gcp; return q; });
        const r = await gs1("PUT", "/console/products/bulk", list);
        const log = (await kvGet("gs1_log")) || [];
        log.unshift({ at: new Date().toISOString(), action: "update", gtins: list.map(p => p.gtin), status: r.status, ok: r.ok, result: r.json || r.text });
        await kvSet("gs1_log", log.slice(0, 100));
        return OK({ ok: r.ok, status: r.status, data: r.json || r.text || r.error });
      }
      case "barcode": {
        const r = await gs1("GET", "/console/products/barcode", null, { gtin: b.gtin, type: b.type || "barcode", format: b.format || "PNG" });
        return OK({ ok: r.ok, status: r.status, file: r.file || null, data: r.json || r.text });
      }
      case "images": {   // ClickIT PUSH: pack photos for a product (base64 JPEG)
        const im = b.images || {}, body = { gtin: String(b.gtin), gcp: GCP };
        ["front", "back", "top", "bottom", "left", "right"].forEach(k => { if (im[k]) { body["img_" + k] = im[k]; body["is_" + k + "_original"] = true; } });
        let r = await gs1("POST", "/console/clickit/products/upload_images", body);
        if (!r.ok && r.status !== 401) {   // some APIs want a data URI instead of plain base64
          const b2 = Object.assign({}, body); Object.keys(b2).forEach(k => { if (/^img_/.test(k)) b2[k] = "data:image/jpeg;base64," + b2[k]; });
          const r2 = await gs1("POST", "/console/clickit/products/upload_images", b2); if (r2.ok) r = r2;
        }
        const log = (await kvGet("gs1_log")) || [];
        log.unshift({ at: new Date().toISOString(), action: "photos (" + Object.keys(im).join(", ") + ")", gtins: [String(b.gtin)], status: r.status, ok: r.ok, result: r.json || r.text });
        await kvSet("gs1_log", log.slice(0, 100));
        return OK({ ok: r.ok, status: r.status, data: r.json || r.text || r.error });
      }
      case "log": return OK({ ok: true, log: (await kvGet("gs1_log")) || [] });
      default: return OK({ error: "unknown action" });
    }
  } catch (e) { return OK({ error: String(e.message || e) }); }
};
