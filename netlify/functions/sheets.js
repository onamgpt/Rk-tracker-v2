// v2.7 per-user sheet routing
const https = require("https");
const url_module = require("url");

const MAIN_SHEET_ID = "11BWMyX8SoEtaDULFS5GylRe6clPjgKBUrlczhkHy7Wg";
const USER_SHEETS = {
  "prakash": "1tBdAr_8Z7NmxbdvBkak8reqb7s1-nk31H3ouE-2u84c",
  // Add more: "satish": "SHEET_ID", "sebi": "SHEET_ID"
};
const SCRIPT_URL = "https://script.google.com/macros/s/AKfycbyeR53nHyQCmk7UGGVcdbapL62AcppjYn_HxhW2AserEoX5uZmHWYNv8q_EAw2k5CqEVw/exec";

exports.handler = async (event) => {
  const h = {
    "Access-Control-Allow-Origin": "*",
    "Content-Type": "application/json",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, GET, OPTIONS"
  };
  if (event.httpMethod === "OPTIONS") return {statusCode:200,headers:h,body:""};

  function makeGet(targetUrl) {
    return new Promise(function(resolve, reject) {
      var rq = https.get(targetUrl, {headers:{"User-Agent":"Mozilla/5.0"}}, function(res) {
        if ([301,302,303,307,308].indexOf(res.statusCode) !== -1 && res.headers.location) {
          res.resume();
          return makeGet(res.headers.location).then(resolve).catch(reject);
        }
        var data = "";
        res.on("data", function(chunk){data += chunk;});
        res.on("end", function(){resolve(data);});
      });
      rq.on("error", reject);
      rq.setTimeout(25000, function(){ rq.destroy(); reject(new Error("Apps Script timeout")); });
    });
  }

  function makePost(targetUrl, postData) {
    return new Promise(function(resolve, reject) {
      var parsed = url_module.parse(targetUrl);
      var bodyStr = typeof postData === "string" ? postData : JSON.stringify(postData);
      var options = {
        hostname: parsed.hostname,
        path: parsed.path,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(bodyStr),
          "User-Agent": "Mozilla/5.0"
        }
      };
      var req = https.request(options, function(res) {
        if (res.statusCode === 301 || res.statusCode === 302) {
          return makeGet(res.headers.location).then(resolve).catch(reject);
        }
        var data = "";
        res.on("data", function(chunk){data += chunk;});
        res.on("end", function(){resolve(data);});
      });
      req.on("error", reject);
      req.write(bodyStr);
      req.end();
    });
  }

  try {
    var body = JSON.parse(event.body || "{}");
    var action = body.action || "getAll";

    // Determine which sheet to use based on user
    var urlUser = (body.user || "main").toLowerCase();
    var sheetId = USER_SHEETS[urlUser] || MAIN_SHEET_ID;

    var raw;

    if (action === "savePortfolio" && body.key && body.data) {
      var ppBody = JSON.stringify({action: "savePortfolio", key: body.key, data: body.data, sheetId: sheetId});
      raw = await makePost(SCRIPT_URL, ppBody);
    } else if (action === "getPortfolio" && body.key) {
      var ppUrl = SCRIPT_URL + "?action=getPortfolio&key=" + encodeURIComponent(body.key) + "&sheetId=" + encodeURIComponent(sheetId);
      raw = await makeGet(ppUrl);
    } else if (action === "save" && body.entry) {
      var entry = Object.assign({}, body.entry);
      var hasAttachments = entry.attachments && entry.attachments.length > 0;
      entry.attachments = hasAttachments ? "["+entry.attachments.length+" files]" : "";
      var postBody = JSON.stringify({action: "save", entry: entry, sheetId: sheetId});
      raw = await makePost(SCRIPT_URL, postBody);
    } else if (action === "delete" && body.id) {
      var delUrl = SCRIPT_URL + "?action=delete&id=" + encodeURIComponent(body.id) + "&sheetId=" + encodeURIComponent(sheetId);
      raw = await makeGet(delUrl);
    } else {
      // getAll, getDropdowns, saveDropdowns etc
      var getUrl = SCRIPT_URL + "?action=" + action + "&sheetId=" + encodeURIComponent(sheetId);
      raw = await makeGet(getUrl);
    }

    try {
      var parsed2 = JSON.parse(raw);
      return {statusCode:200,headers:h,body:JSON.stringify(parsed2)};
    } catch(e) {
      return {statusCode:200,headers:h,body:JSON.stringify({error:"parse_failed", rawHead: String(raw||"").slice(0,1500), rawLen:(raw||"").length})};
    }
  } catch(e) {
    return {statusCode:500,headers:h,body:JSON.stringify({error:e.message})};
  }
};
