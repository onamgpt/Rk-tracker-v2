const https = require("https");

exports.handler = async (event) => {
  const h = {
    "Access-Control-Allow-Origin": "*",
    "Content-Type": "application/json",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS"
  };
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers: h, body: "" };

  try {
    const body = JSON.parse(event.body || "{}");
    const action = body.action || "ping";

    // Try both capitalisation variants
    const CLIENT_ID     = process.env.GOOGLE_OAUTH_CLIENT_ID || process.env.google_oauth_client_id || process.env.Google_oauth_client_id;
    const CLIENT_SECRET = process.env.GOOGLE_OAUTH_CLIENT_SECRET || process.env.Google_oauth_client_secret || process.env.google_oauth_client_secret;
    const REFRESH_TOKEN = process.env.GOOGLE_APPS_SCRIPT_REFRESH_TOKEN;
    const SCRIPT_ID     = process.env.APPS_SCRIPT_ID;

    if (!CLIENT_ID || !CLIENT_SECRET || !REFRESH_TOKEN || !SCRIPT_ID) {
      return { statusCode: 500, headers: h, body: JSON.stringify({ error: "Missing env vars", vars: { CLIENT_ID: !!CLIENT_ID, CLIENT_SECRET: !!CLIENT_SECRET, REFRESH_TOKEN: !!REFRESH_TOKEN, SCRIPT_ID: !!SCRIPT_ID } }) };
    }

    // Validate format
    if (!CLIENT_ID.includes(".apps.googleusercontent.com")) {
      return { statusCode: 500, headers: h, body: JSON.stringify({ error: "CLIENT_ID format wrong — must end in .apps.googleusercontent.com", got: CLIENT_ID.slice(0,30) }) };
    }
    const accessToken = await getAccessToken(CLIENT_ID, CLIENT_SECRET, REFRESH_TOKEN);

    if (action === "ping") {
      return { statusCode: 200, headers: h, body: JSON.stringify({ ok: true, msg: "Apps Script OAuth working", scriptId: SCRIPT_ID.slice(0,8) + "...", clientIdPrefix: CLIENT_ID ? CLIENT_ID.slice(0,20) + "..." : "MISSING", clientSecretPrefix: CLIENT_SECRET ? CLIENT_SECRET.slice(0,6) + "..." : "MISSING" }) };
    }

    if (action === "getCode") {
      const content = await apiCall("GET", "https://script.googleapis.com/v1/projects/" + SCRIPT_ID + "/content", null, accessToken);
      return { statusCode: 200, headers: h, body: JSON.stringify({ ok: true, files: (content.files || []).map(f => ({ name: f.name, lines: (f.source || "").split("\n").length })) }) };
    }

    if (action === "updateCode") {
      const code = body.code;
      const fileName = body.fileName || "Code";
      if (!code) return { statusCode: 400, headers: h, body: JSON.stringify({ error: "No code provided" }) };
      const current = await apiCall("GET", "https://script.googleapis.com/v1/projects/" + SCRIPT_ID + "/content", null, accessToken);
      let files = current.files || [];
      const idx = files.findIndex(f => f.name === fileName);
      if (idx >= 0) files[idx] = { ...files[idx], source: code };
      else files.push({ name: fileName, type: "SERVER_JS", source: code });
      await apiCall("PUT", "https://script.googleapis.com/v1/projects/" + SCRIPT_ID + "/content", { files }, accessToken);
      return { statusCode: 200, headers: h, body: JSON.stringify({ ok: true, msg: "Apps Script updated: " + fileName }) };
    }

    return { statusCode: 400, headers: h, body: JSON.stringify({ error: "Unknown action: " + action }) };

  } catch(e) {
    return { statusCode: 500, headers: h, body: JSON.stringify({ error: e.message, stack: e.stack }) };
  }
};

function getAccessToken(clientId, clientSecret, refreshToken) {
  return new Promise((resolve, reject) => {
    const postData = "client_id=" + encodeURIComponent(clientId) + "&client_secret=" + encodeURIComponent(clientSecret) + "&refresh_token=" + encodeURIComponent(refreshToken) + "&grant_type=refresh_token";
    const req = https.request({ hostname: "oauth2.googleapis.com", path: "/token", method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", "Content-Length": Buffer.byteLength(postData) } }, (res) => {
      let data = "";
      res.on("data", c => data += c);
      res.on("end", () => {
        try {
          const p = JSON.parse(data);
          if (p.access_token) resolve(p.access_token);
          else reject(new Error("Token error: " + data));
        } catch(e) { reject(e); }
      });
    });
    req.on("error", reject);
    req.write(postData);
    req.end();
  });
}

function apiCall(method, url, body, token) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const postData = body ? JSON.stringify(body) : null;
    const req = https.request({ hostname: u.hostname, path: u.pathname + u.search, method, headers: { "Authorization": "Bearer " + token, "Content-Type": "application/json", ...(postData ? { "Content-Length": Buffer.byteLength(postData) } : {}) } }, (res) => {
      let data = "";
      res.on("data", c => data += c);
      res.on("end", () => { try { resolve(JSON.parse(data)); } catch(e) { resolve({ raw: data }); } });
    });
    req.on("error", reject);
    if (postData) req.write(postData);
    req.end();
  });
}
