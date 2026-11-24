/**
 * VM OFFICIAL - VIRAL MEDIA API
 * Cloudflare Workers + D1 + R2
 *
 * D1 Binding: DB
 * D1 Database: vm-database
 *
 * R2 Binding: VIDEOS_BUCKET
 * R2 Bucket: vm-videos
 *
 * Secrets:
 * ADMIN_TOKEN
 *
 * Optional Variables:
 * ALLOWED_ORIGIN
 * DEBUG_ERRORS = true (temporary debugging only)
 */

const JSON_HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store"
};

const MAX_VIDEO_SIZE = 100 * 1024 * 1024;
const MAX_THUMB_SIZE = 10 * 1024 * 1024;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: JSON_HEADERS
  });
}

function cors(request, env) {
  const origin = request.headers.get("Origin") || "";

  const allowed = (env.ALLOWED_ORIGIN || "*")
    .split(",")
    .map(x => x.trim())
    .filter(Boolean);

  const allowOrigin = allowed.includes("*")
    ? "*"
    : allowed.includes(origin)
      ? origin
      : "null";

  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, Range",
    "Access-Control-Expose-Headers":
      "Content-Length, Content-Range, Accept-Ranges, ETag",
    "Vary": "Origin"
  };
}

function withCors(response, request, env) {
  const headers = new Headers(response.headers);

  for (const [key, value] of Object.entries(cors(request, env))) {
    headers.set(key, value);
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

function safeName(name) {
  return (name || "file")
    .normalize("NFKD")
    .replace(/[^a-zA-Z0-9._-]/g, "-")
    .slice(-100);
}

function isAdmin(request, env) {
  const token = request.headers.get("Authorization") || "";

  return Boolean(env.ADMIN_TOKEN) &&
    token === `Bearer ${env.ADMIN_TOKEN}`;
}

function requireDB(env) {
  if (!env.DB) {
    throw new Error("D1 binding DB is missing.");
  }
}

function requireR2(env) {
  if (!env.VIDEOS_BUCKET) {
    throw new Error("R2 binding VIDEOS_BUCKET is missing.");
  }
}

function requireAdmin(request, env) {
  if (!isAdmin(request, env)) {
    return json({ error: "Unauthorized" }, 401);
  }

  return null;
}

function parseCategory(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  const number = Number(value);

  if (!Number.isInteger(number) || number <= 0) {
    return undefined;
  }

  return number;
}

/* =========================
   HEALTH CHECK
========================= */

async function health(env) {
  const result = {
    ok: true,
    service: "vm-api",
    database: false,
    storage: false
  };

  try {
    requireDB(env);

    await env.DB.prepare("SELECT 1 AS test").first();

    result.database = true;
  } catch (error) {
    result.ok = false;
    result.database_error = error.message;
  }

  try {
    requireR2(env);
    result.storage = true;
  } catch (error) {
    result.ok = false;
    result.storage_error = error.message;
  }

  return json(result, result.ok ? 200 : 503);
}

/* =========================
   VIDEO LIST
========================= */

async function listVideos(env) {
  requireDB(env);

  const result = await env.DB.prepare(`
    SELECT
      v.id,
      v.title,
      v.description,
      v.thumbnail_key,
      v.video_key,
      v.category_id,
      c.name AS category,
      v.status,
      v.views,
      v.created_at
    FROM videos v
    LEFT JOIN categories c
      ON c.id = v.category_id
    WHERE v.status = 'published'
    ORDER BY v.created_at DESC
  `).all();

  return result.results || [];
}

/* =========================
   CATEGORIES
========================= */

async function listCategories(env) {
  requireDB(env);

  const result = await env.DB.prepare(`
    SELECT id, name, slug
    FROM categories
    ORDER BY name ASC
  `).all();

  return result.results || [];
}

/* =========================
   R2 MEDIA STREAMING
========================= */

async function streamMedia(request, env, path) {
  requireR2(env);

  let key;

  try {
    key = decodeURIComponent(path.slice("/media/".length));
  } catch (_) {
    return json({ error: "Invalid media key" }, 400);
  }

  if (!key || key.includes("..") || key.startsWith("/")) {
    return json({ error: "Invalid media key" }, 400);
  }

  const object = await env.VIDEOS_BUCKET.get(key, {
    range: request.headers,
    onlyIf: request.headers
  });

  if (!object) {
    return new Response("Media not found", {
      status: 404
    });
  }

  if (!object.body) {
    return new Response(null, {
      status: 304
    });
  }

  const headers = new Headers();

  object.writeHttpMetadata(headers);

  headers.set("ETag", object.httpEtag);
  headers.set("Accept-Ranges", "bytes");
  headers.set("Cache-Control", "public, max-age=3600");

  if (object.range) {
    const start = object.range.offset;
    const end = start + object.range.length - 1;

    headers.set(
      "Content-Range",
      `bytes ${start}-${end}/${object.size}`
    );

    headers.set(
      "Content-Length",
      String(object.range.length)
    );
  } else {
    headers.set("Content-Length", String(object.size));
  }

  return new Response(object.body, {
    status: object.range ? 206 : 200,
    headers
  });
}

/* =========================
   ADMIN VIDEO UPLOAD
========================= */

async function uploadVideo(request, env) {
  requireDB(env);
  requireR2(env);

  const form = await request.formData();

  const video = form.get("video");
  const thumbnail = form.get("thumbnail");

  const title = String(form.get("title") || "").trim();

  const description = String(
    form.get("description") || ""
  );

  const categoryId = parseCategory(
    form.get("category_id")
  );

  if (!title) {
    return json({
      error: "Video title is required."
    }, 400);
  }

  if (!video || typeof video.stream !== "function") {
    return json({
      error: "Video file is required."
    }, 400);
  }

  if (video.size <= 0) {
    return json({
      error: "Video file is empty."
    }, 400);
  }

  if (video.size > MAX_VIDEO_SIZE) {
    return json({
      error: "Video exceeds the 100 MB upload limit."
    }, 413);
  }

  if (categoryId === undefined) {
    return json({
      error: "Invalid category ID."
    }, 400);
  }

  if (
    thumbnail &&
    typeof thumbnail.stream === "function" &&
    thumbnail.size > MAX_THUMB_SIZE
  ) {
    return json({
      error: "Thumbnail exceeds 10 MB."
    }, 413);
  }

  if (categoryId !== null) {
    const category = await env.DB.prepare(
      "SELECT id FROM categories WHERE id = ?"
    ).bind(categoryId).first();

    if (!category) {
      return json({
        error: "Category not found."
      }, 400);
    }
  }

  const id = crypto.randomUUID();

  const videoKey =
    `videos/${id}-${safeName(video.name)}`;

  let thumbnailKey = null;
  let videoUploaded = false;

  try {
    await env.VIDEOS_BUCKET.put(
      videoKey,
      video.stream(),
      {
        httpMetadata: {
          contentType: video.type || "video/mp4"
        }
      }
    );

    videoUploaded = true;

    if (
      thumbnail &&
      typeof thumbnail.stream === "function" &&
      thumbnail.size > 0
    ) {
      thumbnailKey =
        `thumbnails/${id}-${safeName(thumbnail.name)}`;

      await env.VIDEOS_BUCKET.put(
        thumbnailKey,
        thumbnail.stream(),
        {
          httpMetadata: {
            contentType: thumbnail.type || "image/jpeg"
          }
        }
      );
    }

    await env.DB.prepare(`
      INSERT INTO videos (
        id,
        title,
        description,
        thumbnail_key,
        video_key,
        category_id,
        status,
        views,
        created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, 'published', 0, datetime('now'))
    `).bind(
      id,
      title,
      description,
      thumbnailKey,
      videoKey,
      categoryId
    ).run();

    return json({
      ok: true,
      message: "Video uploaded successfully.",
      id,
      title,
      video_url:
        `/media/${encodeURIComponent(videoKey)}`,
      thumbnail_url: thumbnailKey
        ? `/media/${encodeURIComponent(thumbnailKey)}`
        : null
    }, 201);

  } catch (error) {
    if (videoUploaded) {
      await env.VIDEOS_BUCKET.delete(videoKey).catch(() => {});
    }

    if (thumbnailKey) {
      await env.VIDEOS_BUCKET.delete(thumbnailKey).catch(() => {});
    }

    throw error;
  }
}

/* =========================
   ADMIN CREATE CATEGORY
========================= */

async function createCategory(request, env) {
  requireDB(env);

  const body = await request.json();

  const name = String(body.name || "").trim();

  if (!name) {
    return json({
      error: "Category name is required."
    }, 400);
  }

  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "") || `cat-${Date.now()}`;

  const existing = await env.DB.prepare(
    "SELECT id FROM categories WHERE slug = ?"
  ).bind(slug).first();

  if (existing) {
    return json({
      error: "Category already exists."
    }, 409);
  }

  const result = await env.DB.prepare(`
    INSERT INTO categories (name, slug)
    VALUES (?, ?)
  `).bind(name, slug).run();

  return json({
    ok: true,
    id: result.meta.last_row_id,
    name,
    slug
  }, 201);
}

/* =========================
   ADMIN DELETE VIDEO
========================= */

async function deleteVideo(env, id) {
  requireDB(env);
  requireR2(env);

  if (!id) {
    return json({
      error: "Missing video ID."
    }, 400);
  }

  const row = await env.DB.prepare(`
    SELECT video_key, thumbnail_key
    FROM videos
    WHERE id = ?
  `).bind(id).first();

  if (!row) {
    return json({
      error: "Video not found."
    }, 404);
  }

  await env.DB.prepare(
    "DELETE FROM videos WHERE id = ?"
  ).bind(id).run();

  await env.VIDEOS_BUCKET.delete(row.video_key);

  if (row.thumbnail_key) {
    await env.VIDEOS_BUCKET.delete(row.thumbnail_key);
  }

  return json({
    ok: true,
    message: "Video deleted successfully."
  });
}

/* =========================
   MAIN ROUTER
========================= */

async function handle(request, env) {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  if (method === "OPTIONS") {
    return new Response(null, {
      status: 204
    });
  }

  if (path === "/") {
    return json({
      ok: true,
      service: "VM OFFICIAL API",
      version: "2.0",
      endpoints: [
        "/api/health",
        "/api/videos",
        "/api/categories",
        "/media/<key>",
        "/api/admin/upload",
        "/api/admin/categories",
        "/api/admin/videos/<id>"
      ]
    });
  }

  if (path === "/api/health" && method === "GET") {
    return health(env);
  }

  if (path === "/api/videos" && method === "GET") {
    return json(await listVideos(env));
  }

  if (path === "/api/categories" && method === "GET") {
    return json(await listCategories(env));
  }

  if (path.startsWith("/media/") && method === "GET") {
    return streamMedia(request, env, path);
  }

  if (path.startsWith("/api/admin/")) {
    const authError = requireAdmin(request, env);

    if (authError) {
      return authError;
    }
  }

  if (path === "/api/admin/upload" && method === "POST") {
    return uploadVideo(request, env);
  }

  if (path === "/api/admin/categories" && method === "POST") {
    return createCategory(request, env);
  }

  if (
    path.startsWith("/api/admin/videos/") &&
    method === "DELETE"
  ) {
    const id = path.slice(
      "/api/admin/videos/".length
    );

    return deleteVideo(env, decodeURIComponent(id));
  }

  return json({
    error: "Endpoint not found."
  }, 404);
}

/* =========================
   WORKER ENTRY POINT
========================= */

export default {
  async fetch(request, env) {
    try {
      const response = await handle(request, env);

      return withCors(response, request, env);

    } catch (error) {
      console.error("VM OFFICIAL API ERROR:", error);

      const response = json({
        ok: false,
        error: "Server error",
        ...(env.DEBUG_ERRORS === "true"
          ? { detail: String(error?.message || error) }
          : {})
      }, 500);

      return withCors(response, request, env);
    }
  }
};