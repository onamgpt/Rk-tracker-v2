// ONE-TIME MIGRATION: pulls all existing entries from the shared Google Sheet
// (via the original Apps Script URL) and inserts them into the new Postgres
// database. Safe to run multiple times - uses ON CONFLICT DO NOTHING so it
// will never create duplicates or overwrite anything already migrated.
//
// Visit this URL once in your browser after deploy to run it:
//   https://rk-tracker-v2.netlify.app/.netlify/functions/migrate-once
//
// It does NOT touch the original Google Sheet in any way - read only.

const https = require("https");
const { getDatabase } = require("@netlify/database");

const SCRIPT_URL = "https://script.google.com/macros/s/AKfycbyXP_nY13AqlYyif6Kf3rFRayQ_hzOsbisAxe_hT1bd8qkF5wcoJ5qI9dLtMbOTTd4uDg/exec";

function httpGet(targetUrl) {
  return new Promise(function (resolve, reject) {
    https.get(targetUrl, { headers: { "User-Agent": "Mozilla/5.0" } }, function (res) {
      if (res.statusCode === 301 || res.statusCode === 302) {
        return httpGet(res.headers.location).then(resolve).catch(reject);
      }
      var data = "";
      res.on("data", function (c) { data += c; });
      res.on("end", function () { resolve(data); });
    }).on("error", reject);
  });
}

exports.handler = async () => {
  const h = { "Content-Type": "application/json" };
  try {
    const raw = await httpGet(SCRIPT_URL + "?action=getAll");
    let entries;
    try {
      entries = JSON.parse(raw);
    } catch (e) {
      return { statusCode: 500, headers: h, body: JSON.stringify({ error: "Could not parse sheet data", raw: raw.slice(0, 300) }) };
    }
    if (!Array.isArray(entries)) entries = entries.entries || entries.rows || [];

    const db = getDatabase();
    let migrated = 0, skipped = 0, errors = [];

    for (const e of entries) {
      if (!e || !e.id) { skipped++; continue; }
      try {
        const tags = Array.isArray(e.tags) ? e.tags : (typeof e.tags === "string" && e.tags ? e.tags.split(",").map(t => t.trim()).filter(Boolean) : []);
        const attachments = Array.isArray(e.attachments) ? e.attachments : [];

        await db.sql`
          INSERT INTO entries (
            id, title, date, month, category, task_type, person, vendor, account,
            financial_type, payment_status, property, chemical, amount, notes,
            reminder, reminder_note, link, link_label, tags, attachments,
            hidden, recurring, created_at, logged_by, logged_by_name, updated_at
          ) VALUES (
            ${String(e.id)}, ${e.title || ""}, ${e.date || ""}, ${e.month || ""}, ${e.category || ""},
            ${e.taskType || ""}, ${e.person || ""}, ${e.vendor || ""}, ${e.account || ""},
            ${e.financialType || ""}, ${e.paymentStatus || ""}, ${e.property || ""}, ${e.chemical || ""},
            ${e.amount || ""}, ${e.notes || ""}, ${e.reminder || ""}, ${e.reminderNote || ""},
            ${e.link || ""}, ${e.linkLabel || ""}, ${JSON.stringify(tags)}::jsonb, ${JSON.stringify(attachments)}::jsonb,
            ${!!e.hidden}, ${!!e.recurring}, ${e.createdAt || new Date().toISOString()},
            ${e.loggedBy || ""}, ${e.loggedByName || ""}, NOW()
          )
          ON CONFLICT (id) DO NOTHING
        `;
        migrated++;
      } catch (rowErr) {
        errors.push({ id: e.id, error: rowErr.message });
      }
    }

    return {
      statusCode: 200, headers: h,
      body: JSON.stringify({
        success: true,
        totalFoundInSheet: entries.length,
        migrated,
        skipped,
        errors: errors.slice(0, 10),
        message: "Migration complete. Your v1 Google Sheet was NOT modified - read only."
      })
    };
  } catch (e) {
    return { statusCode: 500, headers: h, body: JSON.stringify({ error: e.message }) };
  }
};
