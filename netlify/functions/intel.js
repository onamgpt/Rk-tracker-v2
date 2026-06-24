const https = require("https");
const url_module = require("url");

exports.handler = async (event) => {
  const h = {
    "Access-Control-Allow-Origin": "*",
    "Content-Type": "application/json",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, GET, OPTIONS"
  };
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers: h, body: "" };

  // ⚠️ REPLACE this with the Web App URL of the standalone Email Intel script
  // (the one ending in /exec). Until then, calls return a clear error.
  const INTEL_URL = "PASTE_EMAIL_INTEL_EXEC_URL_HERE";

  if (INTEL_URL.indexOf("PASTE_") === 0) {
    return { statusCode: 200, headers: h, body: JSON.stringify({ ok: false, error: "Intel script URL not set yet" }) };
  }

  function makeGet(targetUrl) {
    return new Promise(function (resolve, reject) {
      https.get(targetUrl, { headers: { "User-Agent": "Mozilla/5.0" } }, function (res) {
        if (res.statusCode === 301 || res.statusCode === 302) {
          return makeGet(res.headers.location).then(resolve).catch(reject);
        }
        var data = "";
        res.on("data", function (c) { data += c; });
        res.on("end", function () { resolve(data); });
      }).on("error", reject);
    });
  }

  function makePost(targetUrl, bodyStr) {
    return new Promise(function (resolve, reject) {
      var p = url_module.parse(targetUrl);
      var options = {
        hostname: p.hostname, path: p.path, method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(bodyStr),
          "User-Agent": "Mozilla/5.0"
        }
      };
      var req = https.request(options, function (res) {
        if (res.statusCode === 301 || res.statusCode === 302) {
          return makeGet(res.headers.location).then(resolve).catch(reject);
        }
        var data = "";
        res.on("data", function (c) { data += c; });
        res.on("end", function () { resolve(data); });
      });
      req.on("error", reject);
      req.write(bodyStr);
      req.end();
    });
  }

  try {
    var body = JSON.parse(event.body || "{}");
    var action = body.action || "ping";
    var raw;

    if (action === "saveEntry" || action === "logIntel") {
      raw = await makePost(INTEL_URL, JSON.stringify(body));
    } else {
      // scanEmails, getIntel, ping → GET with action param
      raw = await makeGet(INTEL_URL + "?action=" + encodeURIComponent(action));
    }

    try {
      return { statusCode: 200, headers: h, body: JSON.stringify(JSON.parse(raw)) };
    } catch (e) {
      return { statusCode: 200, headers: h, body: JSON.stringify({ ok: false, raw: String(raw).slice(0, 200) }) };
    }
  } catch (e) {
    return { statusCode: 500, headers: h, body: JSON.stringify({ error: e.message }) };
  }
};
