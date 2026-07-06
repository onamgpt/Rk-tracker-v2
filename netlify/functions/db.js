// ============================================================================
//  RK TRACKER v2 — REAL DATABASE LAYER (Netlify Blobs)
//  Drop-in replacement for sheets.js. Same actions, structured storage.
//  No cell limits, no column-shift, no whole-dataset wipes.
//  Each entry is stored under its own key: entries/<user>/<id>
//  A bad write can only ever affect ONE record, never all of them.
// ============================================================================
const { getStore } = require("@netlify/blobs");

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

function store() { return getStore("rk-tracker"); }
function entryKey(user, id) { return "entry__" + user + "__" + id; }
function ddKey(user) { return "dropdowns__" + user; }
function ppKey(user, key) { return "portfolio__" + user + "__" + key; }

async function listEntries(s, user) {
  const prefix = "entry__" + user + "__";
  const out = [];
  const { blobs } = await s.list({ prefix });
  for (const b of blobs) {
    try {
      const v = await s.get(b.key, { type: "json" });
      if (v && v.id) out.push(v);
    } catch (e) {}
  }
  return out;
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return OK({});
  let body = {};
  try { body = JSON.parse(event.body || "{}"); } catch (e) {}
  const action = body.action || "getAll";
  const user = String(body.user || "main").toLowerCase();
  const s = store();

  try {
    // ---- READ ALL ----
    if (action === "getAll") {
      const entries = await listEntries(s, user);
      entries.sort((a, b) => String(b.createdAt || b.date || "").localeCompare(String(a.createdAt || a.date || "")));
      return OK({ ok: true, entries, count: entries.length });
    }

    // ---- SAVE / UPSERT (single record only) ----
    if ((action === "save" || action === "saveEntry") && body.entry && body.entry.id) {
      const entry = Object.assign({}, body.entry);
      // Never store heavy base64 — keep only http/drive links
      if (Array.isArray(entry.attachments)) {
        entry.attachments = entry.attachments
          .map(a => (a && a.data && String(a.data).indexOf("http") === 0)
            ? { name: a.name, type: a.type || "drive", data: a.data } : null)
          .filter(Boolean);
      }
      // Route: staff editing an owner-shared entry writes to main
      const target = (user !== "main" && entry._shared) ? "main" : user;
      await s.setJSON(entryKey(target, entry.id), entry);
      return OK({ ok: true, saved: true, id: entry.id });
    }

    // ---- DELETE (single record only) ----
    if (action === "delete" && body.id) {
      try { await s.delete(entryKey(user, body.id)); } catch (e) {}
      // also try main (in case it was a shared entry)
      if (user !== "main") { try { await s.delete(entryKey("main", body.id)); } catch (e) {} }
      return OK({ ok: true, deleted: true });
    }

    // ---- SHARED: entries the owner flagged for this staff user ----
    if (action === "getShared" && body.shareUser) {
      const su = String(body.shareUser).toLowerCase();
      const mainEntries = await listEntries(s, "main");
      const shared = mainEntries.filter(e => {
        const sw = Array.isArray(e.sharedWith) ? e.sharedWith
          : (e.sharedWith ? String(e.sharedWith).split(",").map(x => x.trim()) : []);
        return sw.map(x => String(x).toLowerCase()).indexOf(su) > -1;
      });
      return OK({ ok: true, entries: shared, count: shared.length });
    }

    // ---- DROPDOWNS ----
    if (action === "getDropdowns") {
      let dd = null;
      try { dd = await s.get(ddKey(user), { type: "json" }); } catch (e) {}
      return OK({ ok: true, dropdowns: dd || {} });
    }
    if (action === "saveDropdowns" && body.dropdowns) {
      await s.setJSON(ddKey(user), body.dropdowns);
      return OK({ ok: true, saved: true });
    }

    // ---- PORTFOLIO ----
    if (action === "savePortfolio" && body.key) {
      await s.setJSON(ppKey(user, body.key), { data: body.data, updatedAt: new Date().toISOString() });
      return OK({ ok: true, saved: true });
    }
    if (action === "getPortfolio" && body.key) {
      let v = null;
      try { v = await s.get(ppKey(user, body.key), { type: "json" }); } catch (e) {}
      return OK({ ok: true, data: v ? v.data : null });
    }

    // ---- BULK IMPORT (one-time, for migrating old data) ----
    if (action === "bulkImport" && Array.isArray(body.entries)) {
      let n = 0;
      for (const e of body.entries) {
        if (e && e.id) { await s.setJSON(entryKey(user, e.id), e); n++; }
      }
      return OK({ ok: true, imported: n });
    }

    if (action === "ping") return OK({ ok: true, msg: "DB (Netlify Blobs) alive" });

    return OK({ ok: false, error: "Unknown action: " + action });
  } catch (e) {
    return OK({ ok: false, error: String(e && e.message || e) });
  }
};
