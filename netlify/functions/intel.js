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
  const INTEL_URL = "https://script.google.com/macros/s/AKfycbzTjkBy1M6VeOE0VKbZjlMVitP58kAwKyM1dLYvS0GGpR3pMQtpcvaPmFa7vdv-fSk9/exec";

  if (INTEL_URL.indexOf("PASTE_") === 0) {
    return { statusCode: 200, headers: h, body: JSON.stringify({ ok: false, error: "Intel script URL not set yet" }) };
  }

  function makeGet(targetUrl) {
    return new Promise(function (resolve, reject) {
      var req = https.get(targetUrl, { headers: { "User-Agent": "Mozilla/5.0" }, timeout: 25000 }, function (res) {
        if (res.statusCode === 301 || res.statusCode === 302) {
          return makeGet(res.headers.location).then(resolve).catch(reject);
        }
        var data = "";
        res.on("data", function (c) { data += c; });
        res.on("end", function () { resolve(data); });
      });
      req.on("error", reject);
      req.on("timeout", function() { req.destroy(); reject(new Error("Request timeout")); });
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

    if (action === "fetchDriveFile") {
      const driveId = body.driveId;
      if (!driveId) return { statusCode: 400, headers: h, body: JSON.stringify({ error: "No driveId" }) };
      const fileData = await new Promise((resolve, reject) => {
        const tryFetch = (url) => {
          https.get(url, { headers: { "User-Agent": "Mozilla/5.0" } }, (res) => {
            if (res.statusCode === 301 || res.statusCode === 302) { tryFetch(res.headers.location); return; }
            const chunks = [];
            res.on("data", c => chunks.push(c));
            res.on("end", () => resolve({ buffer: Buffer.concat(chunks), type: res.headers["content-type"] || "image/jpeg" }));
          }).on("error", reject);
        };
        tryFetch("https://drive.google.com/uc?export=download&id=" + driveId);
      });
      const b64 = fileData.buffer.toString("base64");
      return { statusCode: 200, headers: h, body: JSON.stringify({ ok: true, base64: b64, mimeType: fileData.type }) };
    } else if (action === "scanLocationEmails") {
      // Separate scan for #location emails — subject contains "location"
      raw = await makeGet(INTEL_URL + "?action=scanLocationEmails");
    } else if (action === "getAttachment") {
      const gmailId2 = body.gmailId || "";
      const attachIdx = body.attachIndex !== undefined ? body.attachIndex : -1;
      const attachId = body.attachmentId || "";
      const pId = body.partId || "";
      raw = await makeGet(INTEL_URL + "?action=getAttachment&gmailId=" + encodeURIComponent(gmailId2) + "&attachIndex=" + attachIdx + "&attachmentId=" + encodeURIComponent(attachId) + "&partId=" + encodeURIComponent(pId));
    } else if (action === "saveEntry" || action === "logIntel") {
      raw = await makePost(INTEL_URL, JSON.stringify(body));
    } else {
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
