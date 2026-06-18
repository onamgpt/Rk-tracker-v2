const https = require("https");
const url_module = require("url");

exports.handler = async (event) => {
  const h = {
    "Access-Control-Allow-Origin": "*",
    "Content-Type": "application/json",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, GET, OPTIONS"
  };
  if (event.httpMethod === "OPTIONS") return {statusCode:200,headers:h,body:""};

  const SCRIPT_URL = "https://script.google.com/macros/s/AKfycbyXP_nY13AqlYyif6Kf3rFRayQ_hzOsbisAxe_hT1bd8qkF5wcoJ5qI9dLtMbOTTd4uDg/exec";

  function makeGet(targetUrl) {
    return new Promise(function(resolve, reject) {
      https.get(targetUrl, {headers:{"User-Agent":"Mozilla/5.0"}}, function(res) {
        if (res.statusCode === 301 || res.statusCode === 302) {
          return makeGet(res.headers.location).then(resolve).catch(reject);
        }
        var data = "";
        res.on("data", function(chunk){data += chunk;});
        res.on("end", function(){resolve(data);});
      }).on("error", reject);
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
    var raw;

    if (action === "save" && body.entry) {
      // Use POST for save to handle large entries with attachments
      // Strip attachments from Sheets save - save only text data
      var entry = Object.assign({}, body.entry);
      var hasAttachments = entry.attachments && entry.attachments.length > 0;
      entry.attachments = hasAttachments ? "["+entry.attachments.length+" files]" : "";
      var postBody = JSON.stringify({action: "save", entry: entry});
      raw = await makePost(SCRIPT_URL, postBody);
    } else if (action === "delete" && body.id) {
      var delUrl = SCRIPT_URL + "?action=delete&id=" + encodeURIComponent(body.id);
      raw = await makeGet(delUrl);
    } else {
      // getAll, getDropdowns etc
      var getUrl = SCRIPT_URL + "?action=" + action;
      raw = await makeGet(getUrl);
    }

    try {
      var parsed2 = JSON.parse(raw);
      return {statusCode:200,headers:h,body:JSON.stringify(parsed2)};
    } catch(e) {
      return {statusCode:200,headers:h,body:JSON.stringify({success:true,raw:raw.slice(0,100)})};
    }
  } catch(e) {
    return {statusCode:500,headers:h,body:JSON.stringify({error:e.message})};
  }
};
