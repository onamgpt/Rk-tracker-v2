const https = require("https");

exports.handler = async (event) => {
  const h = {
    "Access-Control-Allow-Origin": "*",
    "Content-Type": "application/json",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS"
  };
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers: h, body: "" };

  const makeRequest = (options, body) => new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", chunk => data += chunk);
      res.on("end", () => resolve(data));
    });
    req.on("error", reject);
    req.setTimeout(25000, () => { req.destroy(); reject(new Error("Timeout")); });
    req.write(body);
    req.end();
  });

  try {
    const { prompt, system, imageBase64, imageType } = JSON.parse(event.body || "{}");
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return { statusCode: 500, headers: h, body: JSON.stringify({ error: "API key not set in Netlify environment variables" }) };

    const content = [];
    if (imageBase64) {
      const imgData = imageBase64.length > 1000000 ? imageBase64.slice(0, 1000000) : imageBase64;
      content.push({ type: "image", source: { type: "base64", media_type: imageType || "image/jpeg", data: imgData } });
    }
    content.push({ type: "text", text: prompt || "Hello" });

    const reqBody = JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 1500,
      system: system || "You are a helpful assistant for Onam Agarbathi Pvt. Ltd., a Bangalore incense manufacturer.",
      messages: [{ role: "user", content }]
    });

    const raw = await makeRequest({
      hostname: "api.anthropic.com",
      path: "/v1/messages",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "Content-Length": Buffer.byteLength(reqBody)
      }
    }, reqBody);

    const d = JSON.parse(raw);
    if (d.error) return { statusCode: 500, headers: h, body: JSON.stringify({ error: d.error.message }) };
    return { statusCode: 200, headers: h, body: JSON.stringify({ text: d.content?.[0]?.text || "" }) };
  } catch (e) {
    return { statusCode: 500, headers: h, body: JSON.stringify({ error: e.message }) };
  }
};
