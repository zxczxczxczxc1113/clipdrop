const TUS_LIMIT = 200 * 1024 * 1024;
const MAX_DURATION_SECONDS = 6 * 60 * 60; // 6 hours

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
      'Access-Control-Allow-Headers': 'Content-Type, Upload-Length, Upload-Metadata, Tus-Resumable',
      'Access-Control-Expose-Headers': 'Location, Stream-Media-Id',
    },
  });
}

function tusMetadata(fields) {
  return Object.entries(fields)
    .map(([k, v]) => `${k} ${btoa(String(v))}`)
    .join(',');
}

function clipFromVideo(v) {
  const id = v.uid || v.id;
  const state = v.status?.state;
  const ready = v.readyToStream === true || state === 'ready';
  return {
    id,
    name: v.meta?.name || id,
    size: v.size ?? 0,
    duration: v.duration ?? 0,
    lastModified: v.created || v.modified,
    watchUrl: `/watch.html?clip=${id}`,
    iframeUrl: `https://iframe.cloudflarestream.com/${id}`,
    playbackUrl: v.playback?.hls,
    thumbnail: v.thumbnail,
    playbackReady: ready,
    processing: !ready && state !== 'error',
    pctComplete: v.status?.pctComplete ?? (ready ? 100 : 0),
  };
}

async function handleUploadUrl(request, env) {
  const { filename, contentType, fileSize } = await request.json();
  if (!filename || !fileSize) {
    return json({ error: 'filename and fileSize required' }, 400);
  }

  const meta = { name: filename };

  if (fileSize <= TUS_LIMIT) {
    const direct = await env.STREAM.createDirectUpload({
      maxDurationSeconds: MAX_DURATION_SECONDS,
      meta,
    });
    return json({
      uploadUrl: direct.uploadURL,
      id: direct.id,
      tus: false,
      watchUrl: `/watch.html?clip=${direct.id}`,
    });
  }

  if (!env.CF_API_TOKEN) {
    return json({ error: 'Large uploads need CF_API_TOKEN on the worker' }, 503);
  }

  const endpoint = `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/stream?direct_user=true`;
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.CF_API_TOKEN}`,
      'Tus-Resumable': '1.0.0',
      'Upload-Length': String(fileSize),
      'Upload-Metadata': tusMetadata({
        name: filename,
        filetype: contentType || 'video/mp4',
      }),
    },
  });

  if (!res.ok) {
    const err = await res.text();
    return json({ error: err || 'Could not create upload URL' }, 502);
  }

  const uploadUrl = res.headers.get('Location');
  const id = res.headers.get('Stream-Media-Id');
  if (!uploadUrl || !id) {
    return json({ error: 'Invalid Stream TUS response' }, 502);
  }

  return json({
    uploadUrl,
    id,
    tus: true,
    watchUrl: `/watch.html?clip=${id}`,
  });
}

async function handleListClips(env) {
  const videos = await env.STREAM.videos.list({ limit: 100 });
  const clips = videos
    .map(clipFromVideo)
    .sort((a, b) => new Date(b.lastModified) - new Date(a.lastModified));
  return json({ clips });
}

async function handleClipMeta(id, env) {
  try {
    const video = await env.STREAM.video(id).details();
    return json(clipFromVideo(video));
  } catch {
    return json({ error: 'Clip not found' }, 404);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS' && url.pathname.startsWith('/api/')) {
      return corsPreflight();
    }

    if (url.pathname === '/api/upload-url' && request.method === 'POST') {
      try {
        return await handleUploadUrl(request, env);
      } catch (err) {
        console.error(err);
        return json({ error: err.message || 'Failed to create upload URL' }, 500);
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

    const clipMatch = url.pathname.match(/^\/api\/clips\/([^/]+)$/);
    if (clipMatch && request.method === 'GET') {
      try {
        return await handleClipMeta(clipMatch[1], env);
      } catch (err) {
        return json({ error: 'Clip not found' }, 404);
      }
    }

    return env.ASSETS.fetch(request);
  },
};
