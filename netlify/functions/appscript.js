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
    const { action, code, fileName } = body;

    const CLIENT_ID     = process.env.GOOGLE_OAUTH_CLIENT_ID;
    const CLIENT_SECRET = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
    const REFRESH_TOKEN = process.env.GOOGLE_APPS_SCRIPT_REFRESH_TOKEN;
    const SCRIPT_ID     = process.env.APPS_SCRIPT_ID;

    if (!CLIENT_ID || !CLIENT_SECRET || !REFRESH_TOKEN || !SCRIPT_ID) {
      return { statusCode: 500, headers: h, body: JSON.stringify({ error: "Missing OAuth env vars" }) };
    }

    // ── Step 1: Get fresh access token ──────────────────────────────────
    const accessToken = await getAccessToken(CLIENT_ID, CLIENT_SECRET, REFRESH_TOKEN);

    // ── Action: ping — just verify credentials work ──────────────────────
    if (action === "ping") {
      return { statusCode: 200, headers: h, body: JSON.stringify({ ok: true, msg: "OAuth working — Apps Script auto-update ready" }) };
    }

    // ── Action: getCode — read current script content ────────────────────
    if (action === "getCode") {
      const content = await apiCall("GET",
        "https://script.googleapis.com/v1/projects/" + SCRIPT_ID + "/content",
        null, accessToken
      );
      return { statusCode: 200, headers: h, body: JSON.stringify({ ok: true, files: content.files }) };
    }

    // ── Action: updateCode — push new code to Apps Script ────────────────
    if (action === "updateCode") {
      if (!code) return { statusCode: 400, headers: h, body: JSON.stringify({ error: "No code provided" }) };

      // Get current files first
      const current = await apiCall("GET",
        "https://script.googleapis.com/v1/projects/" + SCRIPT_ID + "/content",
        null, accessToken
      );

      // Replace or add the file
      const targetFile = fileName || "Code";
      const files = (current.files || []).map(f => {
        if (f.name === targetFile) return { ...f, source: code };
        return f;
      });

      // If file didn't exist, add it
      if (!files.find(f => f.name === targetFile)) {
        files.push({ name: targetFile, type: "SERVER_JS", source: code });
      }

      // Push updated content
      await apiCall("PUT",
        "https://script.googleapis.com/v1/projects/" + SCRIPT_ID + "/content",
        { files }, accessToken
      );

      // Create new deployment version
      const deployment = await apiCall("POST",
        "https://script.googleapis.com/v1/projects/" + SCRIPT_ID + "/deployments",
        {
          versionNumber: null,
          manifestFileName: "appsscript",
          description: "Auto-updated by RK Tracker " + new Date().toISOString()
        },
        accessToken
      );

      return { statusCode: 200, headers: h, body: JSON.stringify({
        ok: true,
        msg: "Apps Script updated and deployed successfully",
        deploymentId: deployment.deploymentId
      })};
    }

    return { statusCode: 400, headers: h, body: JSON.stringify({ error: "Unknown action: " + action }) };

  } catch(e) {
    return { statusCode: 500, headers: h, body: JSON.stringify({ error: e.message }) };
  }
};

// ── Get fresh access token from refresh token ────────────────────────────
function getAccessToken(clientId, clientSecret, refreshToken) {
  return new Promise((resolve, reject) => {
    const postData = new URLSearchParams({
      client_id:     clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type:    "refresh_token"
    }).toString();

    const req = https.request({
      hostname: "oauth2.googleapis.com",
      path:     "/token",
      method:   "POST",
      headers:  {
        "Content-Type":   "application/x-www-form-urlencoded",
        "Content-Length": Buffer.byteLength(postData)
      }
    }, (res) => {
      let data = "";
      res.on("data", c => data += c);
      res.on("end", () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.access_token) resolve(parsed.access_token);
          else reject(new Error("No access token: " + data));
        } catch(e) { reject(e); }
      });
    });
    req.on("error", reject);
    req.write(postData);
    req.end();
  });
}

// ── Generic Google API call ──────────────────────────────────────────────
function apiCall(method, url, body, accessToken) {
  return new Promise((resolve, reject) => {
    const urlObj  = new URL(url);
    const postData = body ? JSON.stringify(body) : null;
    const req = https.request({
      hostname: urlObj.hostname,
      path:     urlObj.pathname + urlObj.search,
      method:   method,
      headers:  {
        "Authorization": "Bearer " + accessToken,
        "Content-Type":  "application/json",
        ...(postData ? { "Content-Length": Buffer.byteLength(postData) } : {})
      }
    }, (res) => {
      let data = "";
      res.on("data", c => data += c);
      res.on("end", () => {
        try { resolve(JSON.parse(data)); }
        catch(e) { resolve({ raw: data }); }
      });
    });
    req.on("error", reject);
    if (postData) req.write(postData);
    req.end();
  });
}
