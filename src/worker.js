const TUS_LIMIT = 200 * 1024 * 1024;
const MAX_DURATION_SECONDS = 6 * 60 * 60;
const SESSION_DAYS = 30;

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...extraHeaders,
    },
  });
}

function html(body, status = 200) {
  return new Response(body, {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}

function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/"/g, '&quot;');
}

function siteUrl(request, env) {
  return env.SITE_URL || new URL(request.url).origin;
}

function parseCookies(header) {
  const out = {};
  for (const part of (header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

async function hmacKey(secret) {
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify']
  );
}

async function hashPassword(password, salt) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt: new TextEncoder().encode(salt),
      iterations: 120000,
      hash: 'SHA-256',
    },
    key,
    256
  );
  return btoa(String.fromCharCode(...new Uint8Array(bits)));
}

async function makeSession(userId, env) {
  const exp = Date.now() + SESSION_DAYS * 86400000;
  const payload = `${userId}.${exp}`;
  const sig = await crypto.subtle.sign(
    'HMAC',
    await hmacKey(env.AUTH_SECRET),
    new TextEncoder().encode(payload)
  );
  const sigB64 = btoa(String.fromCharCode(...new Uint8Array(sig)));
  return `${payload}.${sigB64}`;
}

async function readSession(request, env) {
  if (!env.AUTH_SECRET) return null;
  const token = parseCookies(request.headers.get('Cookie')).s;
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [userId, expStr, sigB64] = parts;
  const exp = Number(expStr);
  if (!userId || !exp || Date.now() > exp) return null;
  const payload = `${userId}.${expStr}`;
  const sig = Uint8Array.from(atob(sigB64), (c) => c.charCodeAt(0));
  const ok = await crypto.subtle.verify(
    'HMAC',
    await hmacKey(env.AUTH_SECRET),
    sig,
    new TextEncoder().encode(payload)
  );
  return ok ? userId : null;
}

function sessionCookie(token, secure) {
  const maxAge = SESSION_DAYS * 86400;
  const flags = `Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
  return `s=${token}; ${flags}`;
}

async function getUserRecord(env, username) {
  const key = `auth/users/${username.toLowerCase()}`;
  const obj = await env.BUCKET.get(key);
  if (!obj) return null;
  return obj.json();
}

async function putUserRecord(env, username, record) {
  await env.BUCKET.put(`auth/users/${username.toLowerCase()}`, JSON.stringify(record), {
    httpMetadata: { contentType: 'application/json' },
  });
}

function requireAuth(userId) {
  if (!userId) {
    return json({ error: 'login required' }, 401);
  }
  return null;
}

function tusMetadata(fields) {
  return Object.entries(fields)
    .map(([k, v]) => `${k} ${btoa(String(v))}`)
    .join(',');
}

function clipFromVideo(v, origin) {
  const id = v.uid || v.id;
  const state = v.status?.state;
  const ready = v.readyToStream === true || state === 'ready';
  return {
    id,
    name: v.meta?.name || id,
    size: v.size ?? 0,
    duration: v.duration ?? 0,
    lastModified: v.created || v.modified,
    url: `${origin}/v/${id}`,
    iframeUrl: `https://iframe.cloudflarestream.com/${id}`,
    thumbnail: v.thumbnail,
    playbackReady: ready,
    processing: !ready && state !== 'error',
    pctComplete: v.status?.pctComplete ?? (ready ? 100 : 0),
    owner: v.creator || v.meta?.owner || null,
  };
}

async function handleRegister(request, env) {
  const { user, pass } = await request.json();
  if (!user || !pass || pass.length < 6) {
    return json({ error: 'user and password (6+ chars) required' }, 400);
  }
  if (!/^[a-zA-Z0-9_]{2,32}$/.test(user)) {
    return json({ error: 'invalid username' }, 400);
  }
  if (await getUserRecord(env, user)) {
    return json({ error: 'taken' }, 409);
  }
  const salt = crypto.randomUUID();
  const id = crypto.randomUUID();
  await putUserRecord(env, user, {
    id,
    user,
    salt,
    hash: await hashPassword(pass, salt),
  });
  const token = await makeSession(id, env);
  const secure = new URL(request.url).protocol === 'https:';
  return json({ ok: true }, 200, { 'Set-Cookie': sessionCookie(token, secure) });
}

async function handleLogin(request, env) {
  const { user, pass } = await request.json();
  const record = user ? await getUserRecord(env, user) : null;
  if (!record || (await hashPassword(pass || '', record.salt)) !== record.hash) {
    return json({ error: 'wrong' }, 401);
  }
  const token = await makeSession(record.id, env);
  const secure = new URL(request.url).protocol === 'https:';
  return json({ ok: true }, 200, { 'Set-Cookie': sessionCookie(token, secure) });
}

function handleLogout(request) {
  const secure = new URL(request.url).protocol === 'https:';
  return json({ ok: true }, 200, {
    'Set-Cookie': 's=; Path=/; HttpOnly; Max-Age=0; SameSite=Lax' + (secure ? '; Secure' : ''),
  });
}

async function handleMe(request, env) {
  const userId = await readSession(request, env);
  return json({ loggedIn: !!userId });
}

async function handleUploadUrl(request, env, userId) {
  const denied = requireAuth(userId);
  if (denied) return denied;

  const { filename, contentType, fileSize } = await request.json();
  if (!filename || !fileSize) {
    return json({ error: 'filename and fileSize required' }, 400);
  }

  const origin = siteUrl(request, env);
  const meta = { name: filename, owner: userId };

  if (fileSize <= TUS_LIMIT) {
    const direct = await env.STREAM.createDirectUpload({
      maxDurationSeconds: MAX_DURATION_SECONDS,
      creator: userId,
      meta,
    });
    return json({
      uploadUrl: direct.uploadURL,
      id: direct.id,
      tus: false,
      url: `${origin}/v/${direct.id}`,
    });
  }

  if (!env.CF_API_TOKEN) {
    return json({ error: 'large uploads need CF_API_TOKEN' }, 503);
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
        creator: userId,
      }),
    },
  });

  if (!res.ok) {
    return json({ error: await res.text() || 'upload url failed' }, 502);
  }

  const uploadUrl = res.headers.get('Location');
  const id = res.headers.get('Stream-Media-Id');
  if (!uploadUrl || !id) return json({ error: 'bad stream response' }, 502);

  return json({
    uploadUrl,
    id,
    tus: true,
    url: `${origin}/v/${id}`,
  });
}

async function handleListClips(request, env, userId) {
  const denied = requireAuth(userId);
  if (denied) return denied;

  const origin = siteUrl(request, env);
  const videos = await env.STREAM.videos.list({ limit: 100 });
  const clips = videos
    .filter((v) => (v.creator || v.meta?.owner) === userId)
    .map((v) => clipFromVideo(v, origin))
    .sort((a, b) => new Date(b.lastModified) - new Date(a.lastModified));
  return json({ clips });
}

async function handleClipMeta(request, env, id, userId, isPublic) {
  try {
    const video = await env.STREAM.video(id).details();
    const origin = siteUrl(request, env);
    const clip = clipFromVideo(video, origin);
    if (!isPublic) {
      const denied = requireAuth(userId);
      if (denied) return denied;
      if (clip.owner && clip.owner !== userId) {
        return json({ error: 'not found' }, 404);
      }
    }
    return json(clip);
  } catch {
    return json({ error: 'not found' }, 404);
  }
}

async function watchPage(request, env, id) {
  let video;
  try {
    video = await env.STREAM.video(id).details();
  } catch {
    return html('not found', 404);
  }

  const clip = clipFromVideo(video, siteUrl(request, env));
  const title = esc(clip.name);
  const pageUrl = esc(clip.url);
  const thumb = esc(clip.thumbnail || '');
  const iframe = esc(clip.iframeUrl);

  if (!clip.playbackReady) {
    return html(`<!DOCTYPE html><html><head><meta charset=utf-8><meta http-equiv=refresh content=5><title>${title}</title></head><body>processing</body></html>`);
  }

  return html(`<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta property="og:type" content="video.other">
<meta property="og:url" content="${pageUrl}">
<meta property="og:title" content="${title}">
<meta property="og:image" content="${thumb}">
<meta property="og:video" content="${iframe}">
<meta property="og:video:url" content="${iframe}">
<meta property="og:video:secure_url" content="${iframe}">
<meta property="og:video:type" content="text/html">
<meta property="og:video:width" content="1920">
<meta property="og:video:height" content="1080">
<meta name="twitter:card" content="player">
<meta name="twitter:title" content="${title}">
<meta name="twitter:image" content="${thumb}">
<meta name="twitter:player" content="${iframe}">
<meta name="twitter:player:width" content="1920">
<meta name="twitter:player:height" content="1080">
<title>${title}</title>
<style>*{margin:0;padding:0}html,body{height:100%;background:#000}iframe{width:100%;height:100%;border:0;display:block}</style>
</head>
<body>
<iframe src="${iframe}" allow="accelerometer;gyroscope;autoplay;encrypted-media;picture-in-picture" allowfullscreen></iframe>
</body>
</html>`);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const userId = await readSession(request, env);

    if (url.pathname === '/api/register' && request.method === 'POST') {
      try {
        return await handleRegister(request, env);
      } catch (e) {
        return json({ error: e.message }, 500);
      }
    }

    if (url.pathname === '/api/login' && request.method === 'POST') {
      return handleLogin(request, env);
    }

    if (url.pathname === '/api/logout' && request.method === 'POST') {
      return handleLogout(request);
    }

    if (url.pathname === '/api/me' && request.method === 'GET') {
      return handleMe(request, env);
    }

    if (url.pathname === '/api/upload-url' && request.method === 'POST') {
      try {
        return await handleUploadUrl(request, env, userId);
      } catch (e) {
        return json({ error: e.message }, 500);
      }
    }

    if (url.pathname === '/api/clips' && request.method === 'GET') {
      try {
        return await handleListClips(request, env, userId);
      } catch (e) {
        return json({ error: e.message }, 500);
      }
    }

    const apiClip = url.pathname.match(/^\/api\/clips\/([^/]+)$/);
    if (apiClip && request.method === 'GET') {
      return handleClipMeta(request, env, apiClip[1], userId, false);
    }

    const watch = url.pathname.match(/^\/v\/([^/]+)$/);
    if (watch && request.method === 'GET') {
      return watchPage(request, env, watch[1]);
    }

    return env.ASSETS.fetch(request);
  },
};
