const { getStore } = require("@netlify/blobs");

exports.handler = async (event) => {
  const h = { "Access-Control-Allow-Origin": "*" };
  const key = event.queryStringParameters && event.queryStringParameters.key;
  if (!key) return { statusCode: 400, headers: h, body: "Missing key" };

  try {
    const store = getStore("attachments");
    const result = await store.getWithMetadata(key, { type: "arrayBuffer" });
    if (!result || !result.data) return { statusCode: 404, headers: h, body: "Not found" };

    const contentType = (result.metadata && result.metadata.type) || "application/octet-stream";
    return {
      statusCode: 200,
      headers: { ...h, "Content-Type": contentType },
      body: Buffer.from(result.data).toString("base64"),
      isBase64Encoded: true
    };
  } catch (e) {
    return { statusCode: 500, headers: h, body: "Error: " + e.message };
  }
};
