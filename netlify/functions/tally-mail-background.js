// Picks up the accountant's "backup" emails (Tally Excel exports) from Gmail,
// reads them and stores the figures. Then sends the morning summary.
// Triggered by tally-daily (9:15 IST) or the "Check email now" button.
const T = require("./tally.js");
const G = require("./gmail.js");
const P = require("./tally-parse.js");
const LABEL = { vouchers: "Day Book", tb: "Trial Balance", recv: "Receivables", pay: "Payables", stock: "Stock" };
exports.handler = async (event) => {
  if ((event.headers || {})["x-run-key"] !== T.runKey()) return { statusCode: 403, body: "no" };
  let b = {}; try { b = JSON.parse(event.body || "{}"); } catch (e) {}
  const s = await T.settings();
  const log = (await G.kvGet("tally_mail_log")) || [];
  const entry = { at: new Date().toISOString(), manual: !!b.manual, emails: 0, files: [], error: "" };
  try {
    const seen = (await G.kvGet("tally_mail_seen")) || [];
    const q = "from:(" + s.mailFrom + ") subject:(" + s.mailSubject + ") has:attachment newer_than:" + (b.manual ? 7 : 4) + "d";
    const { tok, messages } = await G.search(q, 10);
    const fresh = messages.filter((m) => seen.indexOf(m.id) < 0).reverse();   // oldest first
    for (const m of fresh) {
      entry.emails++;
      for (const a of m.attachments) {
        const ext = (a.name.split(".").pop() || "").toLowerCase();
        if (["xlsx", "xls", "xlsm", "csv", "xml", "zip"].indexOf(ext) < 0) { entry.files.push(a.name + " — skipped (" + (ext === "pdf" ? "use the upload page for PDF" : "not a report") + ")"); continue; }
        try {
          let buf = await G.attachment(tok, m.id, a.id);
          // XML (preferred: carries ledgers, cheques, cancellations); a .zip of XML/Excel files also works
          if (ext === "zip") {
            const AdmZip = require("adm-zip"); const z = new AdmZip(buf);
            for (const e of z.getEntries()) {
              const en = e.entryName.split("/").pop(), ex = (en.split(".").pop() || "").toLowerCase();
              if (e.isDirectory || ["xml", "xlsx", "xls", "csv"].indexOf(ex) < 0) continue;
              const b2 = e.getData(), r2 = ex === "xml" ? P.parseXmlBuffer(b2, en) : P.parseExcel(b2, en);
              await T.vaultSaveFile(en, ex === "xml" ? "text/xml" : "", b2, { kind: r2.kind, data: r2.data || [], by: "email", source: "email", from: m.from });
              if (r2.error || !r2.data.length) { entry.files.push(en + " — not recognised"); continue; }
              const res2 = await T.ingest(r2.kind, r2.data, en, "email", P.todayIST());
              entry.files.push(en + " — " + LABEL[r2.kind] + ": " + r2.data.length + (res2.ok ? " ✓" : " ✗ " + res2.error));
            }
            continue;
          }
          const r = ext === "xml" ? P.parseXmlBuffer(buf, a.name) : P.parseExcel(buf, a.name);
          await T.vaultSaveFile(a.name, a.type, buf, { kind: r.kind, data: r.data || [], by: "email", source: "email", from: m.from });
          if (r.error || !r.data.length) { entry.files.push(a.name + " — not recognised"); continue; }
          const res = await T.ingest(r.kind, r.data, a.name, "email", P.todayIST());
          entry.files.push(a.name + " — " + LABEL[r.kind] + ": " + r.data.length + (res.ok ? " ✓" : " ✗ " + res.error));
        } catch (e) { entry.files.push(a.name + " — error: " + e.message); }
      }
      seen.push(m.id);
    }
    await G.kvSet("tally_mail_seen", seen.slice(-300));
    if (!fresh.length) entry.files.push("No new backup email from " + s.mailFrom);
  } catch (e) { entry.error = e.message; }
  log.unshift(entry); await G.kvSet("tally_mail_log", log.slice(0, 60));
  if (entry.emails) await T.tg("📧 <b>Tally backup email read</b>\n" + entry.files.map((f) => "• " + f).join("\n"));
  else if (entry.error && !/not connected/i.test(entry.error)) await T.tg("⚠️ Tally email import: " + entry.error);
  if (b.notify !== false) { try { await require("./tally-daily.js").summary(); } catch (e) {} }
  return { statusCode: 200, body: "ok" };
};
