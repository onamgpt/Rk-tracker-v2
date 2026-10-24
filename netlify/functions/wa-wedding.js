// 💍 Wedding Desk on the office WhatsApp number — family only (Ravi, Brunda, Tassmai).
// Send a boy's biodata (photo / PDF / pasted text) → new proposal on the Wedding Desk.
// Send his photos or jathaka → added to that proposal (named in the caption, or the
// one just discussed in this chat). "note on Amrut: good family 4/5", "shortlist Amrut",
// "not proceeding with Amrut", "which proposals are shortlisted?" all work too.
// Data lives in the same kv record the /wedding page uses (pf_wedding_desk). Every
// change is made under a short lock so a burst of photos can't overwrite each other.
const W = require("./wa-lib.js");
const db = require("./db.js");

const FAMILY = { ravi: "main", brunda: "wife", tassmai: "daughter" };
const NAMES = { main: "Ravi", wife: "Brunda", daughter: "Tassmai" };
const KEY = "wedding_desk";
const STATUSES = ["New", "Shortlisted", "Jathaka matched", "Families met", "Yes", "Not proceeding"];
const FIELD_KEYS = ["code", "name", "dob", "tob", "pob", "height", "nakshatra", "rashi", "lagna", "gothra", "mGothra", "puc", "ug", "pg", "occupation", "income",
  "fOcc", "fIncome", "fFamily", "fNative", "mOcc", "mFamily", "mNative", "siblings", "ownHouse", "rental", "assets", "srcName", "srcPhone", "extra"];
const KW = /\b(wedding|marriage|proposals?|alliance|bio-?\s?data|jath?akam?|horoscope|kundl?i|kundali|groom|matrimony|boys?)\b|💍/i;

const fileLink = (path) => W.SITE() + "/.netlify/functions/file?p=" + encodeURIComponent(path) + "&s=" + db.fileSig(path);
const deskLink = (u, id) => W.SITE() + "/wedding/?user=" + u + (id ? "&p=" + encodeURIComponent(id) : "");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const uid = () => "p" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const now = () => new Date().toISOString();

function norm(d) { d = d && typeof d === "object" ? d : {}; return { profiles: Array.isArray(d.profiles) ? d.profiles : [], deleted: Array.isArray(d.deleted) ? d.deleted : [] }; }
async function loadDesk() { return norm(await W.kvGet(KEY)); }

function parseDob(s) {
  s = String(s || "").trim(); let m;
  if ((m = s.match(/^(\d{1,2})[\/\-. ](\d{1,2})[\/\-. ](\d{4})$/))) return new Date(+m[3], +m[2] - 1, +m[1]);
  if ((m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/))) return new Date(+m[1], +m[2] - 1, +m[3]);
  return null;
}
function age(s) { const d = parseDob(s); if (!d || isNaN(d)) return ""; const t = new Date(); let a = t.getFullYear() - d.getFullYear();
  if (t.getMonth() < d.getMonth() || (t.getMonth() === d.getMonth() && t.getDate() < d.getDate())) a--; return a > 0 && a < 100 ? a : ""; }
function label(p) { return "*" + (p.name || "Unnamed proposal") + "*" + ([age(p.dob) ? age(p.dob) + " yrs" : "", p.nakshatra, p.pg || p.ug].filter(Boolean).length ? " (" + [age(p.dob) ? age(p.dob) + " yrs" : "", p.nakshatra, p.pg || p.ug].filter(Boolean).join(", ") + ")" : ""); }

// ---------- lock: one writer at a time on the desk record ----------
const LOCK = "pf_wedding_lock";
async function withDesk(fn) {
  let got = false;
  for (let i = 0; i < 60 && !got; i++) {
    try {
      const r = await W.sb("POST", "/rest/v1/kv?on_conflict=owner,k", [{ owner: "main", k: LOCK, v: { at: Date.now() } }], { Prefer: "resolution=ignore-duplicates,return=representation" });
      if (Array.isArray(r) && r.length) { got = true; break; }
      const cur = await W.sb("GET", "/rest/v1/kv?owner=eq.main&k=eq." + LOCK + "&select=v");
      if (cur && cur[0] && Date.now() - Number((cur[0].v || {}).at || 0) > 45000) await W.sb("DELETE", "/rest/v1/kv?owner=eq.main&k=eq." + LOCK);
    } catch (e) {}
    await sleep(250 + Math.random() * 500);
  }
  try {
    const desk = await loadDesk();
    const out = await fn(desk);
    if (out !== false) await W.kvSet(KEY, desk);
    return out;
  } finally {
    if (got) { try { await W.sb("DELETE", "/rest/v1/kv?owner=eq.main&k=eq." + LOCK); } catch (e) {} }
  }
}
const live = (desk) => desk.profiles.filter((p) => p && p.id && desk.deleted.indexOf(p.id) < 0);
const byId = (desk, id) => live(desk).find((p) => p.id === id);

// ---------- chat memory (kept in each message's own "result", so no shared writes) ----------
async function recent(jid, mins, selfId) {
  const rows = await W.sb("GET", "/rest/v1/wa_messages?chat_jid=eq." + encodeURIComponent(jid) + "&ts=gte." + new Date(Date.now() - mins * 60000).toISOString() +
    "&result=like.wedding*&order=ts.desc&limit=40&select=id,ts,result,media_url,media_name,media_type");
  return (rows || []).filter((r) => r.id !== selfId);
}
function ctxId(rows, desk) {
  for (const r of rows) { const m = String(r.result || "").match(/^wedding:(\S+)/); if (m && byId(desk, m[1])) return m[1]; }
  return null;
}
const pendingOf = (rows) => rows.filter((r) => /^wedding-pending/.test(r.result || "") && r.media_url);

function nameHit(desk, text) {
  const t = String(text || "").toLowerCase();
  if (!t) return null;
  for (const p of live(desk)) {
    const toks = String(p.name || "").split(/[\s.]+/).filter((x) => x.length >= 3).map((x) => x.toLowerCase());
    if (p.code && t.indexOf(String(p.code).toLowerCase()) >= 0) return p;
    if (toks.some((x) => new RegExp("\\b" + x.replace(/[^a-z0-9]/g, "") + "\\b").test(t))) return p;
  }
  return null;
}

function compact(desk) {
  return live(desk).map((p) => {
    const o = { id: p.id, status: p.status || "New", photos: (p.photos || []).length, files: (p.files || []).map((f) => f.kind || "file").join(",") };
    FIELD_KEYS.forEach((k) => { if (p[k]) o[k] = p[k]; });
    if (p.dob && age(p.dob)) o.age = age(p.dob);
    const n = Object.keys(p.notes || {}).map((u) => (NAMES[u] || u) + ": " + (p.notes[u].rating ? p.notes[u].rating + "/5 " : "") + String(p.notes[u].text || "").slice(0, 300)).filter(Boolean);
    if (n.length) o.notes = n;
    if ((p.pros || []).length) o.pros = p.pros.map((x) => x.text);
    if ((p.cons || []).length) o.cons = p.cons.map((x) => x.text);
    if (p.followUp) o.followUp = p.followUp;
    return o;
  });
}

async function think(row, who, media, desk, ctx, pend, quoted) {
  const ctxP = ctx ? byId(desk, ctx) : null;
  const prompt =
`You help Ravi's family (Ravi, his wife Brunda, daughter Tassmai) manage marriage proposals for Tassmai on their private "Wedding Desk".
Today: ${W.istDate()}. Message from: ${NAMES[who]}.
Proposals on the desk (JSON): ${JSON.stringify(compact(desk)).slice(0, 14000)}
${ctxP ? "The proposal just being discussed in this chat: " + ctxP.id + " (" + (ctxP.name || "unnamed") + ")." : "No proposal is being discussed right now."}
${pend.length ? pend.length + " earlier photo/file(s) in this chat are waiting to be told which proposal they belong to." : ""}
${quoted ? "They are replying to this message from the office number: \"\"\"" + String(quoted).slice(0, 600) + "\"\"\"" : ""}
Message text: """${String(row.body || "").slice(0, 6000)}"""
${media ? "An attachment is included above (" + (row.media_name || row.media_type) + ")." : row.media_url ? "There is an attachment that can't be read (" + (row.media_name || row.media_type) + ")." : "No attachment."}

The same WhatsApp number is also used for the family's incense business (orders, bills, LRs, lorry photos, perfumes, staff tasks). Set "wedding": false for anything about that business or not about a marriage proposal. A photo that is a business document, product or goods is NOT wedding.
If wedding, choose ONE action:
- "new": a NEW boy's biodata/profile (not already on the desk; compare name and code). Fill "fields".
- "attach": a photo of a boy/young man, his jathaka/horoscope, or a biodata of a boy ALREADY on the desk — OR a short reply naming which proposal the waiting photos belong to. kind = photo | biodata | jathaka | other. target_id = the proposal (from caption/name, else the one being discussed, else ""). Fill "fields" only from a biodata. If they reply "new" for waiting photos, use action "new" with empty fields.
- "note": their opinion/remark about a boy (rating 1-5 if they give one, e.g. "4 stars", "8/10"→4).
- "status": a decision — one of ${STATUSES.join(", ")} (e.g. "shortlist Amrut" → Shortlisted, "not interested in X" → Not proceeding, "jathaka matched" → Jathaka matched, "we met the family" → Families met). Optional follow_up as YYYY-MM-DD.
- "question": they ask about the proposals — put a short WhatsApp-style answer in "answer" using ONLY the desk data (plain text, *bold* ok, • bullets, no tables).
Field meanings: ${FIELD_KEYS.join(", ")} — dob as dd/mm/yyyy; gothra = boy's own; mGothra = mother's; puc/ug/pg = institutions; fOcc/fIncome/fFamily/fNative and mOcc/mFamily/mNative = parents; assets = other assets in one line; srcName/srcPhone = who sent the proposal. Copy values as written.

Reply with ONLY this JSON:
{"wedding":true,"action":"new|attach|note|status|question","target_id":"","kind":"photo","fields":{},"note":"","rating":0,"status":"","follow_up":"","answer":""}`;
  const content = [];
  if (media) content.push(media.type === "application/pdf"
    ? { type: "document", source: { type: "base64", media_type: "application/pdf", data: media.b64 } }
    : { type: "image", source: { type: "base64", media_type: media.type, data: media.b64 } });
  content.push({ type: "text", text: prompt });
  return W.parseJSON(await W.claude(content, "You manage a family's private marriage-proposal desk. Output only JSON.", 1500));
}

function cleanFields(f) { const o = {}; FIELD_KEYS.forEach((k) => { if (f && f[k] != null && String(f[k]).trim()) o[k] = String(f[k]).trim().slice(0, 500); }); return o; }
function fileObj(r, kind, who) {
  const isImg = /^image\//.test(r.media_type || "");
  return { url: fileLink(r.media_url), name: r.media_name || (isImg ? "whatsapp-photo.jpg" : "whatsapp-file"), type: r.media_type || "", kind: kind === "photo" ? undefined : (kind === "jathaka" ? "Jathaka" : kind === "biodata" ? "Biodata" : ""), addedBy: who, at: now() };
}
function addMedia(p, r, kind, who) {
  const f = fileObj(r, kind, who);
  const isImg = /^image\//.test(r.media_type || "");
  if (kind === "photo" && isImg) { p.photos = p.photos || []; if (!p.photos.some((x) => x.url === f.url)) p.photos.push({ url: f.url, name: f.name, type: f.type, addedBy: who, at: f.at }); }
  else { p.files = p.files || []; if (!p.files.some((x) => x.url === f.url)) p.files.push(f); }
}
function fillBlanks(p, fields) { Object.keys(fields).forEach((k) => { if (!p[k]) p[k] = fields[k]; }); }

// Returns false when the message isn't for the Wedding Desk (normal handling continues),
// otherwise a short result string for the message log.
async function maybeHandle(row, person, media, reply, quoted) {
  const who = FAMILY[person.key];
  if (!who || row.chat_role === "group") return false;
  const text = String(row.body || "").trim();
  const desk = await loadDesk();
  const rows = await recent(row.chat_jid, 10, row.id);
  const ctx = ctxId(rows, desk);
  const pend = pendingOf(await recent(row.chat_jid, 120, row.id));
  const hasMedia = !!row.media_url;

  const signal = KW.test(text) || !!nameHit(desk, text) || /💍/.test(String(quoted || "")) ||
    (ctx && hasMedia && text.length < 120) || (pend.length && !hasMedia && text.length < 80);
  // Uncaptioned photo/PDF from family: let the AI decide if it's a proposal.
  if (!signal && !(hasMedia && media && !text)) return false;

  let d;
  try { d = await think(row, who, media, desk, ctx, pend, quoted); } catch (e) { if (signal) throw e; return false; }
  if (!d || !d.wedding) return false;
  const act = String(d.action || "");
  const fields = cleanFields(d.fields);
  const others = Object.keys(FAMILY).filter((k) => FAMILY[k] !== who);

  if (act === "new") {
    const p = await withDesk((dk) => {
      const p = Object.assign({ id: uid(), status: "New", photos: [], files: [], notes: {}, pros: [], cons: [], comments: [], createdAt: now(), createdBy: who, via: "whatsapp" }, fields);
      if (hasMedia) addMedia(p, row, /^image\//.test(row.media_type || "") && !Object.keys(fields).length ? "photo" : "biodata", who);
      pend.forEach((r) => addMedia(p, r, /^image\//.test(r.media_type || "") ? "photo" : "other", who));
      p.updatedAt = now(); dk.profiles.unshift(p); return p;
    });
    for (const r of pend) { try { await W.sb("PATCH", "/rest/v1/wa_messages?id=eq." + encodeURIComponent(r.id), { result: "wedding:" + p.id + " attach (was waiting)" }, { Prefer: "return=minimal" }); } catch (e) {} }
    await reply("💍 Added " + label(p) + " to the Wedding Desk." + (p.name ? "" : "\nSend his biodata or name so I can fill in the details.") +
      "\nSend his photos or jathaka now and I'll add them to him.\n" + deskLink(who, p.id));
    if (p.name) for (const k of others) await W.send(k, "💍 " + NAMES[who] + " added a new proposal: " + label(p) + "\n" + deskLink(FAMILY[k], p.id));
    return "wedding:" + p.id + " new";
  }

  if (act === "attach") {
    let target = d.target_id && byId(desk, d.target_id) ? d.target_id : null;
    if (!target) { const h = nameHit(desk, text); if (h) target = h.id; }
    if (!target) target = ctx;
    if (!target && hasMedia) {
      // photos often arrive in a burst with the biodata — give the biodata a moment to land
      await sleep(5000 + Math.random() * 5000);
      target = ctxId(await recent(row.chat_jid, 10, row.id), await loadDesk());
    }
    if (!target) {
      if (!hasMedia) { await reply("💍 I couldn't tell which proposal you mean. Reply with his name, or *new*."); return "wedding-ask"; }
      const asked = (await recent(row.chat_jid, 3, row.id)).some((r) => /^wedding-pending asked/.test(r.result || ""));
      if (!asked) await reply("💍 Which proposal is this for? Reply with his name, or *new* for a new one.");
      return "wedding-pending" + (asked ? "" : " asked");
    }
    const kind = ["photo", "biodata", "jathaka", "other"].indexOf(d.kind) >= 0 ? d.kind : "photo";
    const p = await withDesk((dk) => {
      const p = byId(dk, target); if (!p) return null;
      if (hasMedia) addMedia(p, row, kind, who);
      pend.forEach((r) => addMedia(p, r, /^image\//.test(r.media_type || "") ? "photo" : "other", who));
      fillBlanks(p, fields); p.updatedAt = now(); return p;
    });
    if (!p) { await reply("💍 That proposal isn't on the desk any more."); return "wedding-missing"; }
    for (const r of pend) { try { await W.sb("PATCH", "/rest/v1/wa_messages?id=eq." + encodeURIComponent(r.id), { result: "wedding:" + p.id + " attach (was waiting)" }, { Prefer: "return=minimal" }); } catch (e) {} }
    // one reply per burst
    const justSaid = (await recent(row.chat_jid, 1, row.id)).some((r) => r.result === "wedding:" + p.id + " attach");
    if (!justSaid || pend.length) {
      const what = pend.length ? (pend.length + (hasMedia ? 1 : 0)) + " file(s)" : kind === "photo" ? "Photo" : kind === "jathaka" ? "Jathaka" : kind === "biodata" ? "Biodata" : "File";
      await reply("📷 " + what + " added to " + label(p) + " — " + (p.photos || []).length + " photo(s) on file.\n" + deskLink(who, p.id));
    }
    return "wedding:" + p.id + " attach";
  }

  const t = d.target_id && byId(desk, d.target_id) ? byId(desk, d.target_id) : (nameHit(desk, text) || (ctx && byId(desk, ctx)));
  if (act === "note" || act === "status") {
    if (!t) { await reply("💍 Which proposal is this about? Please include his name."); return "wedding-ask"; }
    const rating = Math.max(0, Math.min(5, Math.round(Number(d.rating) || 0)));
    const st = STATUSES.indexOf(d.status) >= 0 ? d.status : "";
    const p = await withDesk((dk) => {
      const p = byId(dk, t.id); if (!p) return null;
      if (act === "note" || d.note) {
        p.notes = p.notes || {}; const n = p.notes[who] || {};
        const add = String(d.note || text).trim();
        p.notes[who] = { text: (n.text ? n.text + "\n" : "") + add, rating: rating || n.rating || 0, at: now() };
      }
      if (st) p.status = st;
      if (/^\d{4}-\d{2}-\d{2}$/.test(d.follow_up || "")) p.followUp = d.follow_up;
      p.updatedAt = now(); return p;
    });
    if (!p) return "wedding-missing";
    if (st) {
      await reply("✔️ " + label(p) + " → *" + st + "*" + (p.followUp ? " · follow up " + p.followUp : "") + "\n" + deskLink(who, p.id));
      for (const k of others) await W.send(k, "💍 " + NAMES[who] + " marked " + label(p) + " as *" + st + "*.\n" + deskLink(FAMILY[k], p.id));
    } else await reply("📝 Noted on " + label(p) + (rating ? " · " + "★".repeat(rating) : "") + ". Brunda, Tassmai and Ravi can all see it on the desk.");
    return "wedding:" + p.id + " " + act;
  }

  if (act === "question") {
    await reply(String(d.answer || "I couldn't find that on the Wedding Desk.").slice(0, 3500) + "\n\n" + (t ? deskLink(who, t.id) : deskLink(who)));
    return t ? "wedding:" + t.id + " question" : "wedding question";
  }
  return false;
}

module.exports = { maybeHandle, FAMILY, withDesk, loadDesk, nameHit, KW };
