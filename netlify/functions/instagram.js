const https = require("https");

// ── Instagram Graph API integration ─────────────────────────────────────
// Actions: getProfile, getMedia, getInsights, replyToComment, sendDM

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

    // Publishing is a two-step handshake: create a media container, wait for
    // Instagram to finish processing it, then publish. Skipping the wait is the
    // usual cause of "media not ready" failures.
    async function publishPost(imageUrl, caption, isVideo) {
      const base = "https://graph.facebook.com/v21.0/" + IG_USER_ID;
      const params = new URLSearchParams({ access_token: ACCESS_TOKEN });
      if (isVideo) { params.set("video_url", imageUrl); params.set("media_type", "REELS"); }
      else { params.set("image_url", imageUrl); }
      if (caption) params.set("caption", caption);

      const createRes = await fetch(base + "/media", { method: "POST", body: params });
      const created = await createRes.json();
      if (!created.id) {
        return { ok: false, step: "create", error: (created.error && created.error.message) || "no container id" };
      }

      // Poll until Instagram reports the container FINISHED. Images are usually
      // instant; video genuinely needs the wait.
      let status = "IN_PROGRESS";
      for (let i = 0; i < 20 && status === "IN_PROGRESS"; i++) {
        await new Promise((r) => setTimeout(r, isVideo ? 3000 : 1000));
        const st = await fetch("https://graph.facebook.com/v21.0/" + created.id +
          "?fields=status_code&access_token=" + encodeURIComponent(ACCESS_TOKEN));
        const stj = await st.json();
        status = stj.status_code || "ERROR";
      }
      if (status !== "FINISHED") {
        return { ok: false, step: "processing", error: "container status: " + status };
      }

      const pubParams = new URLSearchParams({ creation_id: created.id, access_token: ACCESS_TOKEN });
      const pubRes = await fetch(base + "/media_publish", { method: "POST", body: pubParams });
      const published = await pubRes.json();
      if (!published.id) {
        return { ok: false, step: "publish", error: (published.error && published.error.message) || "no post id" };
      }
      return { ok: true, postId: published.id, permalink: "https://www.instagram.com/p/" + published.id };
    }

    const ACCESS_TOKEN = process.env.INSTAGRAM_ACCESS_TOKEN || process.env.WHATSAPP_ACCESS_TOKEN;
    const IG_USER_ID = process.env.INSTAGRAM_USER_ID || "17841461801869834";

    if (!ACCESS_TOKEN) {
      return { statusCode: 500, headers: h, body: JSON.stringify({ error: "Missing INSTAGRAM_ACCESS_TOKEN" }) };
    }

    // ── ping — verify connection ──────────────────────────────────────────
    if (action === "publish") {
      if (!body.imageUrl) {
        return { statusCode: 400, headers: h,
          body: JSON.stringify({ error: "imageUrl is required - Instagram fetches the media from a public URL" }) };
      }
      const r = await publishPost(body.imageUrl, body.caption || "", !!body.isVideo);
      return { statusCode: r.ok ? 200 : 502, headers: h, body: JSON.stringify(r) };
    }

    if (action === "quota") {
      const q = await fetch("https://graph.facebook.com/v21.0/" + IG_USER_ID +
        "/content_publishing_limit?access_token=" + encodeURIComponent(ACCESS_TOKEN));
      return { statusCode: 200, headers: h, body: JSON.stringify(await q.json()) };
    }

    if (action === "ping") {
      const profile = await igGet("/" + IG_USER_ID + "?fields=id,name,username,followers_count,media_count", ACCESS_TOKEN);
      return { statusCode: 200, headers: h, body: JSON.stringify({ ok: true, profile }) };
    }

    // ── getMedia — get recent posts ───────────────────────────────────────
    if (action === "getMedia") {
      const limit = body.limit || 10;
      const data = await igGet("/" + IG_USER_ID + "/media?fields=id,caption,media_type,timestamp,like_count,comments_count,permalink&limit=" + limit, ACCESS_TOKEN);
      return { statusCode: 200, headers: h, body: JSON.stringify({ ok: true, media: data.data || [] }) };
    }

    // ── getComments — get comments on a specific post ─────────────────────
    if (action === "getComments") {
      const { mediaId } = body;
      if (!mediaId) return { statusCode: 400, headers: h, body: JSON.stringify({ error: "Missing mediaId" }) };
      const data = await igGet("/" + mediaId + "/comments?fields=id,text,username,timestamp", ACCESS_TOKEN);
      return { statusCode: 200, headers: h, body: JSON.stringify({ ok: true, comments: data.data || [] }) };
    }

    // ── replyToComment — reply to a comment on a post ─────────────────────
    if (action === "replyToComment") {
      const { mediaId, commentId, message } = body;
      if (!mediaId || !message) return { statusCode: 400, headers: h, body: JSON.stringify({ error: "Missing mediaId/message" }) };
      const endpoint = commentId
        ? "/" + commentId + "/replies"
        : "/" + mediaId + "/comments";
      const result = await igPost(endpoint, { message }, ACCESS_TOKEN);
      return { statusCode: 200, headers: h, body: JSON.stringify({ ok: true, result }) };
    }

    // ── getInsights — account-level insights ─────────────────────────────
    if (action === "getInsights") {
      const data = await igGet("/" + IG_USER_ID + "/insights?metric=impressions,reach,profile_views,website_clicks&period=day&since=" + Math.floor(Date.now()/1000 - 7*86400) + "&until=" + Math.floor(Date.now()/1000), ACCESS_TOKEN);
      return { statusCode: 200, headers: h, body: JSON.stringify({ ok: true, insights: data.data || [] }) };
    }

    // ── getDMs — get recent direct message threads ────────────────────────
    if (action === "getDMs") {
      const data = await igGet("/" + IG_USER_ID + "/conversations?fields=id,updated_time,messages{message,from,created_time}&platform=instagram", ACCESS_TOKEN);
      return { statusCode: 200, headers: h, body: JSON.stringify({ ok: true, conversations: data.data || [] }) };
    }

    // ── replyToDM — reply to a DM thread ────────────────────────────────
    if (action === "replyToDM") {
      const { recipientId, message } = body;
      if (!recipientId || !message) return { statusCode: 400, headers: h, body: JSON.stringify({ error: "Missing recipientId/message" }) };
      const result = await igPost("/me/messages", {
        recipient: { id: recipientId },
        message: { text: message }
      }, ACCESS_TOKEN);
      return { statusCode: 200, headers: h, body: JSON.stringify({ ok: true, result }) };
    }

    return { statusCode: 400, headers: h, body: JSON.stringify({ error: "Unknown action: " + action }) };

  } catch(e) {
    return { statusCode: 500, headers: h, body: JSON.stringify({ error: e.message }) };
  }
};

function igGet(path, token) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: "graph.facebook.com",
      path: "/v21.0" + path + (path.includes("?") ? "&" : "?") + "access_token=" + token,
      method: "GET"
    }, (res) => {
      let data = "";
      res.on("data", c => data += c);
      res.on("end", () => { try { resolve(JSON.parse(data)); } catch(e) { resolve({ raw: data }); } });
    });
    req.on("error", reject);
    req.end();
  });
}

function igPost(path, body, token) {
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify({ ...body, access_token: token });
    const req = https.request({
      hostname: "graph.facebook.com",
      path: "/v21.0" + path,
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(postData) }
    }, (res) => {
      let data = "";
      res.on("data", c => data += c);
      res.on("end", () => { try { resolve(JSON.parse(data)); } catch(e) { resolve({ raw: data }); } });
    });
    req.on("error", reject);
    req.write(postData);
    req.end();
  });
}
