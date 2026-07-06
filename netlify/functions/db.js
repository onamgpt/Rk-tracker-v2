// ============================================================================
//  RK TRACKER v2 — SUPABASE DATABASE LAYER
//  Real database. Structured records. A bad write touches ONE row, never all.
//  Same action surface as the old sheets.js, so the app needs no other changes.
//  Uses Supabase REST (PostgREST) with the SERVICE ROLE key (server-side only).
// ============================================================================
const https = require("https");
const SCRIPT_URL = "https://script.google.com/macros/s/AKfycbyeR53nHyQCmk7UGGVcdbapL62AcppjYn_HxhW2AserEoX5uZmHWYNv8q_EAw2k5CqEVw/exec";
function appscriptPost(bodyObj){
  return new Promise((resolve,reject)=>{
    const u=new URL(SCRIPT_URL);
    const bodyStr=JSON.stringify(bodyObj);
    const req=https.request({hostname:u.hostname,path:u.pathname,method:"POST",headers:{"Content-Type":"application/json","Content-Length":Buffer.byteLength(bodyStr),"User-Agent":"Mozilla/5.0"}},(res)=>{
      if([301,302,303,307,308].indexOf(res.statusCode)!==-1&&res.headers.location){
        // follow redirect via GET
        https.get(res.headers.location,{headers:{"User-Agent":"Mozilla/5.0"}},(r2)=>{let d="";r2.on("data",c=>d+=c);r2.on("end",()=>{try{resolve(JSON.parse(d));}catch(e){resolve({raw:d});}});}).on("error",reject);
        return;
      }
      let d="";res.on("data",c=>d+=c);res.on("end",()=>{try{resolve(JSON.parse(d));}catch(e){resolve({raw:d});}});
    });
    req.on("error",reject);
    req.setTimeout(25000,()=>{req.destroy();reject(new Error("Drive upload timeout"));});
    req.write(bodyStr);req.end();
  });
}

const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_KEY || "";

const OK = (obj) => ({
  statusCode: 200,
  headers: {
    "Access-Control-Allow-Origin": "*",
    "Content-Type": "application/json",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, GET, OPTIONS"
  },
  body: JSON.stringify(obj)
});

function sb(method, path, bodyObj, extraHeaders) {
  return new Promise((resolve, reject) => {
    const u = new URL(SUPABASE_URL + path);
    const bodyStr = bodyObj !== undefined ? JSON.stringify(bodyObj) : null;
    const headers = Object.assign({
      "apikey": SERVICE_KEY,
      "Authorization": "Bearer " + SERVICE_KEY,
      "Content-Type": "application/json"
    }, extraHeaders || {});
    if (bodyStr) headers["Content-Length"] = Buffer.byteLength(bodyStr);
    const req = https.request({
      hostname: u.hostname, path: u.pathname + u.search, method, headers
    }, (res) => {
      let data = "";
      res.on("data", c => data += c);
      res.on("end", () => {
        let parsed = null;
        try { parsed = data ? JSON.parse(data) : null; } catch (e) { parsed = data; }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on("error", reject);
    req.setTimeout(9000, () => { req.destroy(); reject(new Error("Supabase timeout")); });
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

// Map app entry (camelCase) -> DB row (snake_case) + keep full copy in `data`
function toRow(e, owner) {
  return {
    id: String(e.id), owner: owner,
    title: e.title || "", date: e.date || "", month: e.month || "",
    category: e.category || "", task_type: e.taskType || "",
    person: e.person || "", vendor: e.vendor || "", account: e.account || "",
    financial_type: e.financialType || "", payment_status: e.paymentStatus || "",
    property: e.property || "", chemical: e.chemical || "", amount: e.amount || "",
    notes: e.notes || "", reminder: e.reminder || "", reminder_note: e.reminderNote || "",
    link: e.link || "", link_label: e.linkLabel || "",
    created_at: e.createdAt || "", updated_at: e.updatedAt || new Date().toISOString(),
    logged_by: e.loggedBy || "", logged_by_name: e.loggedByName || "",
    tags: Array.isArray(e.tags) ? e.tags : (e.tags ? String(e.tags).split(",").map(t=>t.trim()).filter(Boolean) : []),
    attachments: Array.isArray(e.attachments)
      ? e.attachments.filter(a => a && a.data && String(a.data).indexOf("http") === 0)
                     .map(a => ({ name: a.name, type: a.type || "drive", data: a.data }))
      : [],
    shared_with: Array.isArray(e.sharedWith) ? e.sharedWith : (e.sharedWith ? String(e.sharedWith).split(",").map(t=>t.trim()).filter(Boolean) : []),
    hidden: !!e.hidden, recurring: !!e.recurring,
    data: e
  };
}

// Map DB row -> app entry (prefer the stored full copy, fall back to columns)
function fromRow(r) {
  const base = (r.data && typeof r.data === "object") ? r.data : {};
  return Object.assign({
    id: r.id, title: r.title, date: r.date, month: r.month, category: r.category,
    taskType: r.task_type, person: r.person, vendor: r.vendor, account: r.account,
    financialType: r.financial_type, paymentStatus: r.payment_status, property: r.property,
    chemical: r.chemical, amount: r.amount, notes: r.notes, reminder: r.reminder,
    reminderNote: r.reminder_note, link: r.link, linkLabel: r.link_label,
    createdAt: r.created_at, updatedAt: r.updated_at, loggedBy: r.logged_by,
    loggedByName: r.logged_by_name, tags: r.tags || [], attachments: r.attachments || [],
    sharedWith: r.shared_with || [], hidden: !!r.hidden, recurring: !!r.recurring
  }, base);
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return OK({});
  if (!SUPABASE_URL || !SERVICE_KEY) {
    return OK({ error: "Supabase not configured — set SUPABASE_URL and SUPABASE_SERVICE_KEY in Netlify env." });
  }
  let body = {};
  try { body = JSON.parse(event.body || "{}"); } catch (e) {}
  const action = body.action || "getAll";
  const owner = String(body.user || "main").toLowerCase();

  try {
    if (action === "ping") return OK({ ok: true, msg: "Supabase DB alive" });

    // ---- UPLOAD FILE -> Google Drive (via Apps Script). Images live in Drive, links in Supabase.
    if (action === "uploadFile" && body.file) {
      try {
        const r = await appscriptPost({ action: "uploadFile", file: body.file });
        return OK(r || { error: "no response from Drive" });
      } catch (e) {
        return OK({ error: "drive_upload_failed", detail: String(e && e.message || e) });
      }
    }

    // ---- READ ALL ----
    if (action === "getAll") {
      const r = await sb("GET", "/rest/v1/entries?owner=eq." + encodeURIComponent(owner) + "&select=*", undefined);
      if (r.status >= 400) return OK({ error: "read_failed", detail: r.body });
      const entries = (Array.isArray(r.body) ? r.body : []).map(fromRow);
      entries.sort((a, b) => String(b.createdAt || b.date || "").localeCompare(String(a.createdAt || a.date || "")));
      return OK({ ok: true, entries, count: entries.length });
    }

    // ---- SAVE / UPSERT (one row) ----
    if ((action === "save" || action === "saveEntry") && body.entry && body.entry.id) {
      const target = (owner !== "main" && body.entry._shared) ? "main" : owner;
      const row = toRow(body.entry, target);
      const r = await sb("POST", "/rest/v1/entries?on_conflict=id", row, { "Prefer": "resolution=merge-duplicates,return=minimal" });
      if (r.status >= 400) return OK({ error: "save_failed", detail: r.body });
      return OK({ ok: true, saved: true, id: row.id });
    }

    // ---- DELETE (one row) ----
    if (action === "delete" && body.id) {
      const r = await sb("DELETE", "/rest/v1/entries?id=eq." + encodeURIComponent(body.id), undefined, { "Prefer": "return=minimal" });
      return OK({ ok: true, deleted: r.status < 400 });
    }

    // ---- SHARED entries for a staff user ----
    if (action === "getShared" && body.shareUser) {
      const su = String(body.shareUser).toLowerCase();
      const r = await sb("GET", "/rest/v1/entries?owner=eq.main&shared_with=cs." + encodeURIComponent(JSON.stringify([su])) + "&select=*", undefined);
      const entries = (Array.isArray(r.body) ? r.body : []).map(fromRow).map(e => Object.assign(e, { _shared: true }));
      return OK({ ok: true, entries, count: entries.length });
    }

    // ---- DROPDOWNS ----
    if (action === "getDropdowns") {
      const r = await sb("GET", "/rest/v1/kv?owner=eq." + encodeURIComponent(owner) + "&k=eq.dropdowns&select=v", undefined);
      const v = (Array.isArray(r.body) && r.body[0]) ? r.body[0].v : {};
      return OK({ ok: true, dropdowns: v || {} });
    }
    if (action === "saveDropdowns" && body.dropdowns) {
      await sb("POST", "/rest/v1/kv?on_conflict=owner,k", { owner, k: "dropdowns", v: body.dropdowns }, { "Prefer": "resolution=merge-duplicates,return=minimal" });
      return OK({ ok: true, saved: true });
    }

    // ---- PORTFOLIO ----
    if (action === "savePortfolio" && body.key) {
      await sb("POST", "/rest/v1/kv?on_conflict=owner,k", { owner, k: "pf_" + body.key, v: body.data }, { "Prefer": "resolution=merge-duplicates,return=minimal" });
      return OK({ ok: true, saved: true });
    }
    if (action === "getPortfolio" && body.key) {
      const r = await sb("GET", "/rest/v1/kv?owner=eq." + encodeURIComponent(owner) + "&k=eq." + encodeURIComponent("pf_" + body.key) + "&select=v", undefined);
      const v = (Array.isArray(r.body) && r.body[0]) ? r.body[0].v : null;
      return OK({ ok: true, data: v });
    }

    // ---- BULK IMPORT (migrate old data) ----
    if (action === "bulkImport" && Array.isArray(body.entries)) {
      const rows = body.entries.filter(e => e && e.id).map(e => toRow(e, owner));
      if (!rows.length) return OK({ ok: true, imported: 0 });
      const r = await sb("POST", "/rest/v1/entries?on_conflict=id", rows, { "Prefer": "resolution=merge-duplicates,return=minimal" });
      if (r.status >= 400) return OK({ error: "import_failed", detail: r.body });
      return OK({ ok: true, imported: rows.length });
    }

    return OK({ ok: false, error: "Unknown action: " + action });
  } catch (e) {
    return OK({ ok: false, error: String(e && e.message || e) });
  }
};
