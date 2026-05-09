// BOXIV-only: LINE webhook で受信した画像 / 動画 / 音声 / ファイルを R2 に保存し、
// messages_log の content として URL+メタデータの JSON を返す。

const LINE_DATA_API = 'https://api-data.line.me/v2/bot';

const EXT_FROM_MIME: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'audio/mp4': 'm4a',
  'audio/mpeg': 'mp3',
  'audio/aac': 'aac',
  'audio/x-m4a': 'm4a',
  'audio/wav': 'wav',
  'application/pdf': 'pdf',
};

function pickExtension(mime: string, fallback: string): string {
  const norm = mime.split(';')[0].trim().toLowerCase();
  return EXT_FROM_MIME[norm] ?? fallback;
}

interface IncomingMediaInfo {
  kind: 'image' | 'video' | 'audio' | 'file';
  url: string;        // public-facing URL (Worker proxy)
  key: string;        // R2 key
  mimeType: string;
  size: number;
  filename?: string;
  duration?: number;  // ms (video / audio)
}

/**
 * Download a LINE message's binary content and persist to R2.
 * Returns metadata suitable for storing in `messages_log.content`.
 */
export async function ingestLineMedia(
  bucket: R2Bucket,
  channelAccessToken: string,
  workerUrl: string,
  messageId: string,
  kind: IncomingMediaInfo['kind'],
  hint?: { fileName?: string; duration?: number },
): Promise<IncomingMediaInfo> {
  const res = await fetch(`${LINE_DATA_API}/message/${messageId}/content`, {
    headers: { Authorization: `Bearer ${channelAccessToken}` },
  });
  if (!res.ok) {
    throw new Error(`LINE Data API ${res.status}: ${await res.text().catch(() => '')}`);
  }
  const mimeType = res.headers.get('content-type') ?? 'application/octet-stream';
  const buffer = await res.arrayBuffer();
  const ext = pickExtension(mimeType, kind === 'image' ? 'jpg' : kind === 'video' ? 'mp4' : kind === 'audio' ? 'm4a' : 'bin');
  const key = `media/${kind}/${messageId}.${ext}`;
  await bucket.put(key, buffer, {
    httpMetadata: { contentType: mimeType },
    customMetadata: {
      originalFilename: hint?.fileName ?? `${messageId}.${ext}`,
      kind,
      source: 'line-webhook',
    },
  });
  return {
    kind,
    url: `${workerUrl}/media/${encodeURIComponent(key)}`,
    key,
    mimeType,
    size: buffer.byteLength,
    filename: hint?.fileName,
    duration: hint?.duration,
  };
}
