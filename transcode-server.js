require('dotenv').config();
const express = require('express');
const { spawn } = require('child_process');
const fs = require('fs/promises');
const path = require('path');
const os = require('os');
const {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
} = require('@aws-sdk/client-s3');

// Use system ffmpeg in Docker; ffmpeg-static locally on Windows dev
let ffmpegPath = 'ffmpeg';
try {
  ffmpegPath = require('ffmpeg-static') || 'ffmpeg';
} catch {
  ffmpegPath = 'ffmpeg';
}

const {
  CLOUDFLARE_ACCOUNT_ID,
  R2_ACCESS_KEY_ID,
  R2_SECRET_ACCESS_KEY,
  R2_BUCKET_NAME = 'clips',
  R2_PUBLIC_URL,
  TRANSCODE_SECRET,
  PORT = 3001,
} = process.env;

const app = express();
app.use(express.json());

const s3 = new S3Client({
  region: 'auto',
  endpoint: `https://${CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: R2_ACCESS_KEY_ID,
    secretAccessKey: R2_SECRET_ACCESS_KEY,
  },
});

function webKeyFor(key) {
  const m = key.match(/^clips\/([^-]+)-/);
  return m ? `clips/${m[1]}-web.mp4` : null;
}

function auth(req, res, next) {
  if (TRANSCODE_SECRET && req.headers['x-transcode-secret'] !== TRANSCODE_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

async function streamToFile(body, dest) {
  const chunks = [];
  for await (const chunk of body) chunks.push(chunk);
  await fs.writeFile(dest, Buffer.concat(chunks));
}

function runFfmpeg(input, output) {
  return new Promise((resolve, reject) => {
    const args = [
      '-y', '-i', input,
      '-threads', '1',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23',
      '-vf', 'scale=-2:720',
      '-c:a', 'aac', '-b:a', '128k',
      '-movflags', '+faststart', '-pix_fmt', 'yuv420p',
      output,
    ];
    const proc = spawn(ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    proc.stderr.on('data', (d) => { err += d; });
    proc.on('error', (e) => reject(e));
    proc.on('close', (code) => (code === 0 ? resolve() : reject(new Error(err.slice(-500) || `ffmpeg exit ${code}`))));
  });
}

async function transcodeKey(key) {
  const webKey = webKeyFor(key);
  if (!webKey) throw new Error('Invalid key');

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'clipdrop-'));
  const inputPath = path.join(tmpDir, 'input');
  const outputPath = path.join(tmpDir, 'output.mp4');

  try {
    const obj = await s3.send(new GetObjectCommand({ Bucket: R2_BUCKET_NAME, Key: key }));
    await streamToFile(obj.Body, inputPath);
    await runFfmpeg(inputPath, outputPath);
    const outBuf = await fs.readFile(outputPath);
    await s3.send(new PutObjectCommand({
      Bucket: R2_BUCKET_NAME,
      Key: webKey,
      Body: outBuf,
      ContentType: 'video/mp4',
    }));
    return { webKey, publicUrl: `${R2_PUBLIC_URL}/${webKey}` };
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

const running = new Set();

app.get('/health', (_req, res) => res.json({ ok: true }));

app.post('/transcode', auth, (req, res) => {
  const { key } = req.body;
  if (!key) return res.status(400).json({ error: 'key required' });

  const webKey = webKeyFor(key);
  if (!webKey) return res.status(400).json({ error: 'invalid key' });
  if (running.has(key)) return res.json({ status: 'processing', webKey });

  running.add(key);
  res.json({ status: 'processing', webKey });

  transcodeKey(key)
    .then((result) => console.log('Done', result.webKey))
    .catch((err) => console.error('Transcode failed', key, err.message))
    .finally(() => running.delete(key));
});

app.listen(PORT, '0.0.0.0', () => console.log(`Transcoder listening on ${PORT}, ffmpeg: ${ffmpegPath}`));
