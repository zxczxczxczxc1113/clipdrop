import { AwsClient } from 'aws4fetch';

const CLIP_PREFIX = 'clips/';

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    },
  });
}

function corsPreflight() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}

function safeName(filename) {
  return filename.replace(/[^a-zA-Z0-9._-]/g, '_');
}

function webKeyFor(key) {
  const m = key.match(/^clips\/([^-]+)-/);
  return m ? `clips/${m[1]}-web.mp4` : null;
}

function clipMeta(key, obj, publicUrl) {
  const name = key.split('/').pop();
  return {
    key,
    name,
    size: obj.size,
    lastModified: obj.uploaded instanceof Date ? obj.uploaded.toISOString() : obj.uploaded,
    watchUrl: `/watch.html?clip=${encodeURIComponent(key)}`,
    publicUrl: `${publicUrl}/${key}`,
  };
}

async function clipMetaFull(key, obj, env) {
  const base = clipMeta(key, obj, env.R2_PUBLIC_URL);
  const webKey = webKeyFor(key);
  if (webKey) {
    try {
      const web = await env.BUCKET.head(webKey);
      if (web) {
        return {
          ...base,
          playbackUrl: `${env.R2_PUBLIC_URL}/${webKey}`,
          playbackReady: true,
          processing: false,
        };
      }
    } catch {
      /* not ready */
    }
  }
  return { ...base, playbackUrl: base.publicUrl, playbackReady: false, processing: !!webKey };
}

async function handleTranscode(request, env) {
  const { key } = await request.json();
  if (!key) return json({ error: 'key required' }, 400);
  if (!env.TRANSCODE_SERVICE_URL) {
    return json({ error: 'Transcoder not deployed yet' }, 503);
  }

  const headers = { 'Content-Type': 'application/json' };
  if (env.TRANSCODE_SECRET) headers['x-transcode-secret'] = env.TRANSCODE_SECRET;

  const res = await fetch(`${env.TRANSCODE_SERVICE_URL}/transcode`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ key }),
  });
  if (!res.ok) {
    const err = await res.text();
    return json({ error: err || 'Transcoder error' }, 502);
  }
  return json(await res.json());
}

async function handleUploadUrl(request, env) {
  const { filename, contentType } = await request.json();
  if (!filename || !contentType) {
    return json({ error: 'filename and contentType required' }, 400);
  }

  const id = crypto.randomUUID().slice(0, 12);
  const key = `${CLIP_PREFIX}${id}-${safeName(filename)}`;

  const client = new AwsClient({
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
  });

  const objectUrl = `https://${env.CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com/${env.BUCKET_NAME}/${key}`;
  const signed = await client.sign(
    new Request(objectUrl, {
      method: 'PUT',
      headers: { 'Content-Type': contentType },
    }),
    { aws: { signQuery: true, expires: 3600 } }
  );

  return json({
    uploadUrl: signed.url,
    key,
    watchUrl: `/watch.html?clip=${encodeURIComponent(key)}`,
    publicUrl: `${env.R2_PUBLIC_URL}/${key}`,
  });
}

async function handleListClips(env) {
  const listed = await env.BUCKET.list({ prefix: CLIP_PREFIX });
  const objects = (listed.objects || [])
    .filter((obj) => obj.size > 0 && !obj.key.endsWith('-web.mp4') && !obj.key.startsWith('assets/'))
    .sort((a, b) => new Date(b.uploaded) - new Date(a.uploaded));
  const clips = await Promise.all(objects.map((obj) => clipMetaFull(obj.key, obj, env)));
  return json({ clips });
}

async function handleClipMeta(key, env) {
  const obj = await env.BUCKET.head(key);
  if (!obj) return json({ error: 'Clip not found' }, 404);
  return json(await clipMetaFull(key, obj, env));
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS' && url.pathname.startsWith('/api/')) {
      return corsPreflight();
    }

    if (url.pathname === '/api/transcode' && request.method === 'POST') {
      try {
        return await handleTranscode(request, env);
      } catch (err) {
        console.error(err);
        return json({ error: err.message || 'Transcode failed' }, 500);
      }
    }

    if (url.pathname === '/api/upload-url' && request.method === 'POST') {
      try {
        return await handleUploadUrl(request, env);
      } catch (err) {
        console.error(err);
        return json({ error: 'Failed to create upload URL' }, 500);
      }
    }

    if (url.pathname === '/api/clips' && request.method === 'GET') {
      try {
        return await handleListClips(env);
      } catch (err) {
        console.error(err);
        return json({ error: 'Failed to list clips' }, 500);
      }
    }

    const clipMatch = url.pathname.match(/^\/api\/clips\/(.+)$/);
    if (clipMatch && request.method === 'GET') {
      try {
        return await handleClipMeta(decodeURIComponent(clipMatch[1]), env);
      } catch (err) {
        return json({ error: 'Clip not found' }, 404);
      }
    }

    return env.ASSETS.fetch(request);
  },
};
