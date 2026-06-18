// Scheduled function: runs daily at 11:00 AM IST (05:30 UTC)
// Checks all entries for invoice payment follow-ups.
//
// SALES - PAYMENT (Onam Agarbathi invoices issued to customers — they owe Onam):
//   - Day 45 after invoice date: reminder
//   - Day 60 after invoice date: reminder
//   - Day 61 onwards: reminder EVERY DAY until marked Paid
//
// BUSINESS - PURCHASE (purchases made by Onam — Onam owes vendor):
//   - Day 60 after invoice date: single reminder
//
// Stops reminding once paymentStatus is "Paid".

const https = require("https");

const SCRIPT_URL = "https://script.google.com/macros/s/AKfycbyXP_nY13AqlYyif6Kf3rFRayQ_hzOsbisAxe_hT1bd8qkF5wcoJ5qI9dLtMbOTTd4uDg/exec";
const BOT_TOKEN = "8852628858:AAHAZ3ZjosHPrEC0OU8fDnRXBNcKnwO2gus";
const CHAT_ID = "8632288596";

function httpGet(targetUrl) {
  return new Promise(function(resolve, reject) {
    https.get(targetUrl, {headers:{"User-Agent":"Mozilla/5.0"}}, function(res) {
      if (res.statusCode === 301 || res.statusCode === 302) {
        return httpGet(res.headers.location).then(resolve).catch(reject);
      }
      var data = "";
      res.on("data", function(chunk){ data += chunk; });
      res.on("end", function(){ resolve(data); });
    }).on("error", reject);
  });
}

// Uses the SAME action name ("getAll") the live app already uses against this Apps Script.
function getAllEntries() {
  return httpGet(SCRIPT_URL + "?action=getAll");
}

function tgSend(text) {
  return new Promise(function(resolve, reject) {
    var payload = JSON.stringify({chat_id: CHAT_ID, text: text, parse_mode: "HTML"});
    var req = https.request({
      hostname: "api.telegram.org",
      path: "/bot" + BOT_TOKEN + "/sendMessage",
      method: "POST",
      headers: {"Content-Type":"application/json","Content-Length":Buffer.byteLength(payload)}
    }, function(res) {
      var data = "";
      res.on("data", function(c){ data += c; });
      res.on("end", function(){ resolve(data); });
    });
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

function daysBetween(dateStr, today) {
  var d = new Date(dateStr);
  if (isNaN(d.getTime())) return null;
  var diffMs = today.setHours(0,0,0,0) - new Date(d.setHours(0,0,0,0)).getTime();
  return Math.round(diffMs / 86400000);
}

function fmtRupee(amount) {
  if (!amount) return "";
  return String(amount).indexOf("₹") >= 0 ? amount : "₹" + amount;
}

export default async function handler(req) {
  var results = { salesReminded: [], purchaseReminded: [], errors: [] };

  try {
    var raw = await getAllEntries();
    var data;
    try {
      data = JSON.parse(raw);
    } catch (e) {
      results.errors.push("Failed to parse sheet data: " + e.message);
      return new Response(JSON.stringify(results), {status: 200});
    }

    var entries = Array.isArray(data) ? data : (data.entries || data.rows || []);
    var today = new Date();

    for (var i = 0; i < entries.length; i++) {
      var e = entries[i];
      if (!e || !e.category || !e.date) continue;

      var status = (e.paymentStatus || "").trim();
      if (status === "Paid") continue; // never remind once paid

      var age = daysBetween(e.date, new Date(today));
      if (age === null || age < 0) continue;

      // SALES - PAYMENT: customer owes Onam Agarbathi
      if (e.category === "Sales - Payment") {
        var shouldRemind = (age === 45) || (age === 60) || (age >= 61);
        if (shouldRemind) {
          var msg = "🔔 <b>Payment Follow-up Reminder</b>\n"
            + "📄 " + (e.title || "Invoice") + "\n"
            + "👤 " + (e.person || e.vendor || "Customer") + "\n"
            + "💰 " + fmtRupee(e.amount) + "\n"
            + "📅 Invoice date: " + e.date + " (" + age + " days ago)\n"
            + "📊 Status: " + (status || "Pending") + "\n"
            + (age >= 61 ? "⚠️ <b>OVERDUE — daily reminder</b>" : (age === 60 ? "⚠️ 60 days overdue" : "⏰ 45 days reminder"));
          await tgSend(msg);
          results.salesReminded.push({id: e.id, title: e.title, age: age});
        }
      }

      // BUSINESS - PURCHASE: Onam owes vendor
      if (e.category === "Business - Purchase") {
        if (age === 60) {
          var msg2 = "🔔 <b>Vendor Payment Reminder</b>\n"
            + "📄 " + (e.title || "Purchase") + "\n"
            + "🏭 " + (e.vendor || e.person || "Vendor") + "\n"
            + "💰 " + fmtRupee(e.amount) + "\n"
            + "📅 Purchase date: " + e.date + " (60 days ago)\n"
            + "📊 Status: " + (status || "Pending");
          await tgSend(msg2);
          results.purchaseReminded.push({id: e.id, title: e.title, age: age});
        }
      }
    }
  } catch (err) {
    results.errors.push(err.message);
  }

  return new Response(JSON.stringify(results), {status: 200});
}

export const config = {
  schedule: "30 5 * * *" // 05:30 UTC = 11:00 AM IST, every day
};
