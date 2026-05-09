// BOXIV-only: チャットでやり取りする画像・動画・PDF のアップロード/配信。
// 既存 /api/images は画像専用バリデーションなので、汎用 /api/media を別建て。
//
// POST /api/media     — multipart/form-data で 1 ファイルアップロード
// GET  /media/:key    — Worker 経由で R2 配信（LINE 公式に渡す originalContentUrl 用）

import { Hono } from 'hono';
import type { Env } from '../index.js';

const media = new Hono<Env>();

const MIME_LIMITS: Record<string, { ext: string; maxBytes: number; kind: 'image' | 'video' | 'file' }> = {
  'image/jpeg':       { ext: 'jpg',  maxBytes: 10 * 1024 * 1024, kind: 'image' },
  'image/png':        { ext: 'png',  maxBytes: 10 * 1024 * 1024, kind: 'image' },
  'image/gif':        { ext: 'gif',  maxBytes: 10 * 1024 * 1024, kind: 'image' },
  'image/webp':       { ext: 'webp', maxBytes: 10 * 1024 * 1024, kind: 'image' },
  'video/mp4':        { ext: 'mp4',  maxBytes: 200 * 1024 * 1024, kind: 'video' },
  'video/quicktime':  { ext: 'mov',  maxBytes: 200 * 1024 * 1024, kind: 'video' },
  'application/pdf':  { ext: 'pdf',  maxBytes: 20 * 1024 * 1024, kind: 'file' },
};

function lookupMime(rawType: string): { ext: string; maxBytes: number; kind: 'image' | 'video' | 'file' } | null {
  const normalized = rawType.split(';')[0].trim().toLowerCase();
  return MIME_LIMITS[normalized] ?? null;
}

media.post('/api/media', async (c) => {
  try {
    const contentType = c.req.header('Content-Type') || '';
    let buffer: ArrayBuffer;
    let mimeType: string;
    let filename: string | undefined;

    if (contentType.includes('multipart/form-data')) {
      const form = await c.req.formData();
      const file = form.get('file');
      // In Cloudflare Workers FormData entries are FormDataEntryValue (string | Blob-like).
      // Treat anything with arrayBuffer() as a file.
      const blobLike = file as unknown as { arrayBuffer?: () => Promise<ArrayBuffer>; type?: string; name?: string };
      if (!blobLike || typeof blobLike.arrayBuffer !== 'function') {
        return c.json({ success: false, error: 'file field is required' }, 400);
      }
      buffer = await blobLike.arrayBuffer();
      mimeType = blobLike.type || 'application/octet-stream';
      filename = blobLike.name;
    } else if (contentType.includes('application/json')) {
      const body = await c.req.json<{ data: string; mimeType: string; filename?: string }>();
      if (!body.data || !body.mimeType) {
        return c.json({ success: false, error: 'data and mimeType are required' }, 400);
      }
      let base64 = body.data;
      if (base64.startsWith('data:')) {
        const m = base64.match(/^data:([^;]+);base64,(.+)$/);
        if (m) {
          mimeType = m[1];
          base64 = m[2];
        } else {
          mimeType = body.mimeType;
        }
      } else {
        mimeType = body.mimeType;
      }
      const binary = Uint8Array.from(atob(base64), (ch) => ch.charCodeAt(0));
      buffer = binary.buffer;
      filename = body.filename;
    } else {
      // raw body upload
      buffer = await c.req.arrayBuffer();
      mimeType = contentType.split(';')[0] || 'application/octet-stream';
    }

    const policy = lookupMime(mimeType);
    if (!policy) {
      return c.json({
        success: false,
        error: `Unsupported MIME: ${mimeType}. Allowed: ${Object.keys(MIME_LIMITS).join(', ')}`,
      }, 400);
    }
    if (buffer.byteLength > policy.maxBytes) {
      return c.json({
        success: false,
        error: `File too large (max ${Math.floor(policy.maxBytes / (1024 * 1024))}MB for ${mimeType})`,
      }, 400);
    }

    const id = crypto.randomUUID();
    const key = `media/${policy.kind}/${id}.${policy.ext}`;
    await c.env.IMAGES.put(key, buffer, {
      httpMetadata: { contentType: mimeType },
      customMetadata: {
        originalFilename: filename ?? `${id}.${policy.ext}`,
        kind: policy.kind,
      },
    });

    const workerUrl = c.env.WORKER_URL || new URL(c.req.url).origin;
    const url = `${workerUrl}/media/${encodeURIComponent(key)}`;

    return c.json({
      success: true,
      data: {
        id,
        key,
        url,
        kind: policy.kind,
        mimeType,
        filename: filename ?? null,
        size: buffer.byteLength,
      },
    }, 201);
  } catch (err) {
    console.error('POST /api/media error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// Public proxy: GET /media/{...key}
// `key` includes slashes (`media/image/<uuid>.jpg`); param('*') captures the rest.
media.get('/media/*', async (c) => {
  const url = new URL(c.req.url);
  // strip leading "/media/"
  const key = decodeURIComponent(url.pathname.replace(/^\/media\//, ''));
  if (!key) return c.json({ success: false, error: 'invalid key' }, 400);

  const object = await c.env.IMAGES.get(key);
  if (!object) {
    return c.json({ success: false, error: 'Not found' }, 404);
  }
  const headers = new Headers();
  headers.set('Content-Type', object.httpMetadata?.contentType || 'application/octet-stream');
  headers.set('Cache-Control', 'public, max-age=31536000, immutable');
  headers.set('ETag', object.etag);
  // For PDFs, hint inline rendering. For attachments, allow filename.
  const filename = object.customMetadata?.originalFilename;
  if (filename) {
    headers.set('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(filename)}`);
  }
  return new Response(object.body, { headers });
});

export { media };
