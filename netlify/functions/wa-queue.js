// WhatsApp outbound queue (Supabase table wa_outbox, one row per message).
// The Mac Mini bridge polls "pending", sends, then "ack"s with WhatsApp's id.
// Bridge calls need the x-bridge-key header. Other functions should use
// require("./wa-lib.js").send() directly; "add" over HTTP also needs the key.
const W = require("./wa-lib.js");
const H = { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json", "Access-Control-Allow-Headers": "Content-Type, x-bridge-key", "Access-Control-Allow-Methods": "GET, POST, OPTIONS" };
const OK = (o, c) => ({ statusCode: c || 200, headers: H, body: JSON.stringify(o) });

// One-time move of anything still sitting in the old kv queue.
async function drainOldKv() {
  try {
    const cur = await W.kvGet("wa_queue");
    const items = (cur && cur.items) || [];
    const left = items.filter((x) => !x.sent);
    if (!left.length) return;
    for (const x of left) await W.send(x.to, x.message || "");
    await W.kvSet("wa_queue", { items: items.map((x) => Object.assign(x, { sent: true, movedToTable: true })) });
  } catch (e) {}
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return OK({});
  let b = {}; try { b = JSON.parse(event.body || "{}"); } catch (e) {}
  const q = event.queryStringParameters || {};
  const action = b.action || q.action || "pending";
  const internal = !!event.__internal;
  if (!internal && !(await W.bridgeOk(event))) return OK({ ok: false, error: "bridge key required" }, 403);

  if (action === "people") return OK({ ok: true, people: W.PEOPLE });

  if (action === "add") {
    const rows = await W.send(Array.isArray(b.to) ? b.to : [b.to], b.message || "");
    return OK({ ok: true, added: rows.map((r) => r.id) });
  }

  if (action === "ack") {
    const patch = b.error ? { status: "failed", error: String(b.error).slice(0, 300) } : { status: "sent", sent_at: new Date().toISOString(), wa_id: b.waId || null };
    await W.sb("PATCH", "/rest/v1/wa_outbox?id=eq." + encodeURIComponent(b.id), patch, { Prefer: "return=minimal" });
    return OK({ ok: true });
  }

  // default: pending jobs for the bridge (oldest first)
  await drainOldKv();
  const rows = await W.sb("GET", "/rest/v1/wa_outbox?status=eq.pending&order=id.asc&limit=40&select=id,to_jid,body,media_url,media_name");
  return OK({ ok: true, jobs: (rows || []).map((r) => ({ id: r.id, to: r.to_jid, message: r.body, mediaUrl: r.media_url, mediaName: r.media_name })) });
};
