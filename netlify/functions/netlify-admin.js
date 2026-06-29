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
    const NETLIFY_TOKEN = process.env.NETLIFY_TOKEN;

    if (!NETLIFY_TOKEN) return { statusCode: 500, headers: h, body: JSON.stringify({ error: "NETLIFY_TOKEN not set" }) };

    if (action === "ping") {
      const user = await netlifyAPI("GET", "/api/v1/user", null, NETLIFY_TOKEN);
      return { statusCode: 200, headers: h, body: JSON.stringify({ ok: true, msg: "Netlify API working", user: user.full_name, email: user.email }) };
    }

    if (action === "listSites") {
      const sites = await netlifyAPI("GET", "/api/v1/sites", null, NETLIFY_TOKEN);
      return { statusCode: 200, headers: h, body: JSON.stringify({ ok: true, sites: sites.map(s => ({ id: s.id, name: s.name, url: s.default_domain, account: s.account_slug })) }) };
    }

    if (action === "setEnvVar") {
      const { accountSlug, siteId, key, value } = body;
      try {
        await netlifyAPI("PATCH", "/api/v1/accounts/" + accountSlug + "/env/" + key, { value, context: "all" }, NETLIFY_TOKEN);
      } catch(e) {
        await netlifyAPI("POST", "/api/v1/accounts/" + accountSlug + "/env", [{ key, values: [{ value, context: "all" }] }], NETLIFY_TOKEN);
      }
      return { statusCode: 200, headers: h, body: JSON.stringify({ ok: true, msg: "Env var " + key + " set" }) };
    }

    if (action === "triggerDeploy") {
      const { siteId } = body;
      const build = await netlifyAPI("POST", "/api/v1/sites/" + siteId + "/builds", {}, NETLIFY_TOKEN);
      return { statusCode: 200, headers: h, body: JSON.stringify({ ok: true, msg: "Deploy triggered", buildId: build.id, state: build.state }) };
    }

    return { statusCode: 400, headers: h, body: JSON.stringify({ error: "Unknown action: " + action }) };

  } catch(e) {
    return { statusCode: 500, headers: h, body: JSON.stringify({ error: e.message }) };
  }
};

function netlifyAPI(method, path, body, token) {
  return new Promise((resolve, reject) => {
    const postData = body ? JSON.stringify(body) : null;
    const req = https.request({ hostname: "api.netlify.com", path, method, headers: { "Authorization": "Bearer " + token, "Content-Type": "application/json", ...(postData ? { "Content-Length": Buffer.byteLength(postData) } : {}) } }, (res) => {
      let data = "";
      res.on("data", c => data += c);
      res.on("end", () => { try { resolve(JSON.parse(data)); } catch(e) { resolve({ raw: data }); } });
    });
    req.on("error", reject);
    if (postData) req.write(postData);
    req.end();
  });
}
