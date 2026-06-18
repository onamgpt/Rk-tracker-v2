const { getDatabase } = require("@netlify/database");
const { getStore } = require("@netlify/blobs");

exports.handler = async (event) => {
  const h = {
    "Access-Control-Allow-Origin": "*",
    "Content-Type": "application/json",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, GET, OPTIONS"
  };
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers: h, body: "" };

  const db = getDatabase();

  // Map our JS camelCase entry shape <-> snake_case DB columns
  const toDbRow = (e) => ({
    id: e.id,
    title: e.title || "",
    date: e.date || "",
    month: e.month || "",
    category: e.category || "",
    task_type: e.taskType || "",
    person: e.person || "",
    vendor: e.vendor || "",
    account: e.account || "",
    financial_type: e.financialType || "",
    payment_status: e.paymentStatus || "",
    property: e.property || "",
    chemical: e.chemical || "",
    amount: e.amount || "",
    notes: e.notes || "",
    reminder: e.reminder || "",
    reminder_note: e.reminderNote || "",
    link: e.link || "",
    link_label: e.linkLabel || "",
    tags: JSON.stringify(Array.isArray(e.tags) ? e.tags : []),
    attachments: JSON.stringify(Array.isArray(e.attachments) ? e.attachments : []),
    hidden: !!e.hidden,
    recurring: !!e.recurring,
    created_at: e.createdAt || new Date().toISOString(),
    logged_by: e.loggedBy || "",
    logged_by_name: e.loggedByName || ""
  });

  const fromDbRow = (r) => ({
    id: r.id,
    title: r.title,
    date: r.date,
    month: r.month,
    category: r.category,
    taskType: r.task_type,
    person: r.person,
    vendor: r.vendor,
    account: r.account,
    financialType: r.financial_type,
    paymentStatus: r.payment_status,
    property: r.property,
    chemical: r.chemical,
    amount: r.amount,
    notes: r.notes,
    reminder: r.reminder,
    reminderNote: r.reminder_note,
    link: r.link,
    linkLabel: r.link_label,
    tags: typeof r.tags === "string" ? JSON.parse(r.tags) : (r.tags || []),
    attachments: typeof r.attachments === "string" ? JSON.parse(r.attachments) : (r.attachments || []),
    hidden: !!r.hidden,
    recurring: !!r.recurring,
    createdAt: r.created_at,
    loggedBy: r.logged_by,
    loggedByName: r.logged_by_name
  });

  try {
    const body = JSON.parse(event.body || "{}");
    const action = body.action || "getAll";

    if (action === "save" && body.entry) {
      const row = toDbRow(body.entry);
      await db.sql`
        INSERT INTO entries (
          id, title, date, month, category, task_type, person, vendor, account,
          financial_type, payment_status, property, chemical, amount, notes,
          reminder, reminder_note, link, link_label, tags, attachments,
          hidden, recurring, created_at, logged_by, logged_by_name, updated_at
        ) VALUES (
          ${row.id}, ${row.title}, ${row.date}, ${row.month}, ${row.category}, ${row.task_type},
          ${row.person}, ${row.vendor}, ${row.account}, ${row.financial_type}, ${row.payment_status},
          ${row.property}, ${row.chemical}, ${row.amount}, ${row.notes}, ${row.reminder},
          ${row.reminder_note}, ${row.link}, ${row.link_label}, ${row.tags}::jsonb, ${row.attachments}::jsonb,
          ${row.hidden}, ${row.recurring}, ${row.created_at}, ${row.logged_by}, ${row.logged_by_name}, NOW()
        )
        ON CONFLICT (id) DO UPDATE SET
          title=EXCLUDED.title, date=EXCLUDED.date, month=EXCLUDED.month, category=EXCLUDED.category,
          task_type=EXCLUDED.task_type, person=EXCLUDED.person, vendor=EXCLUDED.vendor,
          account=EXCLUDED.account, financial_type=EXCLUDED.financial_type, payment_status=EXCLUDED.payment_status,
          property=EXCLUDED.property, chemical=EXCLUDED.chemical, amount=EXCLUDED.amount, notes=EXCLUDED.notes,
          reminder=EXCLUDED.reminder, reminder_note=EXCLUDED.reminder_note, link=EXCLUDED.link,
          link_label=EXCLUDED.link_label, tags=EXCLUDED.tags, attachments=EXCLUDED.attachments,
          hidden=EXCLUDED.hidden, recurring=EXCLUDED.recurring, logged_by=EXCLUDED.logged_by,
          logged_by_name=EXCLUDED.logged_by_name, updated_at=NOW()
      `;
      return { statusCode: 200, headers: h, body: JSON.stringify({ success: true, id: row.id }) };
    }

    if (action === "delete" && body.id) {
      await db.sql`DELETE FROM entries WHERE id = ${body.id}`;
      return { statusCode: 200, headers: h, body: JSON.stringify({ success: true }) };
    }

    if (action === "getDropdowns") {
      const rows = await db.sql`SELECT key, value FROM dropdowns`;
      const out = {};
      rows.forEach(r => { out[r.key] = typeof r.value === "string" ? JSON.parse(r.value) : r.value; });
      return { statusCode: 200, headers: h, body: JSON.stringify(out) };
    }

    if (action === "saveDropdowns" && body.dropdowns) {
      for (const [key, value] of Object.entries(body.dropdowns)) {
        await db.sql`
          INSERT INTO dropdowns (key, value) VALUES (${key}, ${JSON.stringify(value)}::jsonb)
          ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
        `;
      }
      return { statusCode: 200, headers: h, body: JSON.stringify({ success: true }) };
    }

    if (action === "uploadFile" && body.file) {
      const store = getStore("attachments");
      const key = Date.now() + "_" + Math.random().toString(36).slice(2, 8) + "_" + (body.file.name || "file");
      const base64Data = body.file.data.includes(",") ? body.file.data.split(",")[1] : body.file.data;
      const buffer = Buffer.from(base64Data, "base64");
      const realType = body.file.type || "application/octet-stream";
      await store.set(key, buffer, { metadata: { name: body.file.name || "", type: realType } });
      // The front-end's existing uploadToDrive() expects back {url, id} and will
      // wrap it itself as {name, type:"drive", data:url, driveId:id}. Match that contract.
      return {
        statusCode: 200, headers: h,
        body: JSON.stringify({
          success: true,
          url: "/.netlify/functions/db-file?key=" + encodeURIComponent(key),
          id: key
        })
      };
    }

    // default: getAll
    const rows = await db.sql`SELECT * FROM entries ORDER BY date DESC`;
    return { statusCode: 200, headers: h, body: JSON.stringify(rows.map(fromDbRow)) };

  } catch (e) {
    return { statusCode: 500, headers: h, body: JSON.stringify({ error: e.message }) };
  }
};
