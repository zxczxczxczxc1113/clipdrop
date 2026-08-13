require('dotenv').config();
const express = require('express');
const { spawn } = require('child_process');
const fsSync = require('fs');
const { pipeline } = require('stream/promises');
const fs = require('fs/promises');
const path = require('path');
const os = require('os');
const {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
} = require('@aws-sdk/client-s3');

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
app.use(express.json({ limit: '1mb' }));

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
  await pipeline(body, fsSync.createWriteStream(dest));
}

function runFfmpeg(input, output) {
  return new Promise((resolve, reject) => {
    const args = [
      '-y', '-i', input,
      '-threads', '1',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '28',
      '-vf', 'scale=-2:480',
      '-c:a', 'aac', '-b:a', '96k',
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
  const inputPath = path.join(tmpDir, 'input.mp4');
  const outputPath = path.join(tmpDir, 'output.mp4');

  try {
    console.log('Transcode start', key);
    const obj = await s3.send(new GetObjectCommand({ Bucket: R2_BUCKET_NAME, Key: key }));
    await streamToFile(obj.Body, inputPath);
    console.log('Downloaded', key, (await fs.stat(inputPath)).size, 'bytes');
    await runFfmpeg(inputPath, outputPath);
    const outStat = await fs.stat(outputPath);
    console.log('Encoded', webKey, outStat.size, 'bytes');
    await s3.send(new PutObjectCommand({
      Bucket: R2_BUCKET_NAME,
      Key: webKey,
      Body: fsSync.createReadStream(outputPath),
      ContentType: 'video/mp4',
      ContentLength: outStat.size,
    }));
    console.log('Done', webKey);
    return { webKey, publicUrl: `${R2_PUBLIC_URL}/${webKey}` };
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

const running = new Set();

app.get('/health', (_req, res) => res.json({ ok: true, ffmpeg: ffmpegPath }));

app.post('/transcode', auth, (req, res) => {
  const { key } = req.body;
  if (!key) return res.status(400).json({ error: 'key required' });

  const webKey = webKeyFor(key);
  if (!webKey) return res.status(400).json({ error: 'invalid key' });
  if (running.has(key)) return res.json({ status: 'processing', webKey });

  running.add(key);
  res.json({ status: 'processing', webKey });

  transcodeKey(key)
    .catch((err) => console.error('Transcode failed', key, err.message))
    .finally(() => running.delete(key));
});

app.listen(PORT, '0.0.0.0', () => console.log(`Transcoder listening on ${PORT}, ffmpeg: ${ffmpegPath}`));
