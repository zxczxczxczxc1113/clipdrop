require('dotenv').config();
const express = require('express');
const path = require('path');
const crypto = require('crypto');
const {
  S3Client,
  PutObjectCommand,
  ListObjectsV2Command,
  HeadObjectCommand,
} = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

const {
  CLOUDFLARE_ACCOUNT_ID,
  R2_ACCESS_KEY_ID,
  R2_SECRET_ACCESS_KEY,
  R2_BUCKET_NAME = 'clips',
  R2_PUBLIC_URL,
  PORT = 3000,
} = process.env;

const missing = [
  'CLOUDFLARE_ACCOUNT_ID',
  'R2_ACCESS_KEY_ID',
  'R2_SECRET_ACCESS_KEY',
  'R2_PUBLIC_URL',
].filter((k) => !process.env[k]);

if (missing.length) {
  console.error(`Missing env: ${missing.join(', ')}`);
  process.exit(1);
}

const s3 = new S3Client({
  region: 'auto',
  endpoint: `https://${CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: R2_ACCESS_KEY_ID,
    secretAccessKey: R2_SECRET_ACCESS_KEY,
  },
});

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.post('/api/upload-url', async (req, res) => {
  try {
    const { filename, contentType } = req.body;
    if (!filename || !contentType) {
      return res.status(400).json({ error: 'filename and contentType required' });
    }
    const id = crypto.randomUUID().slice(0, 12);
    const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
    const key = `clips/${id}-${safeName}`;
    const command = new PutObjectCommand({
      Bucket: R2_BUCKET_NAME,
      Key: key,
      ContentType: contentType,
    });
    const uploadUrl = await getSignedUrl(s3, command, { expiresIn: 3600 });
    res.json({
      uploadUrl,
      key,
      watchUrl: `/watch.html?clip=${encodeURIComponent(key)}`,
      publicUrl: `${R2_PUBLIC_URL}/${key}`,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create upload URL' });
  }
});

app.get('/api/clips', async (_req, res) => {
  try {
    const result = await s3.send(
      new ListObjectsV2Command({ Bucket: R2_BUCKET_NAME, Prefix: 'clips/' })
    );
    const clips = (result.Contents || [])
      .filter((o) => o.Size > 0)
      .sort((a, b) => new Date(b.LastModified) - new Date(a.LastModified))
      .map((o) => ({
        key: o.Key,
        name: o.Key.split('/').pop(),
        size: o.Size,
        lastModified: o.LastModified,
        watchUrl: `/watch.html?clip=${encodeURIComponent(o.Key)}`,
        publicUrl: `${R2_PUBLIC_URL}/${o.Key}`,
      }));
    res.json({ clips });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to list clips' });
  }
});

app.get('/api/clips/:key(*)', async (req, res) => {
  try {
    const key = req.params.key;
    const result = await s3.send(
      new HeadObjectCommand({ Bucket: R2_BUCKET_NAME, Key: key })
    );
    res.json({
      key,
      name: key.split('/').pop(),
      size: result.ContentLength,
      lastModified: result.LastModified,
      publicUrl: `${R2_PUBLIC_URL}/${key}`,
    });
  } catch {
    res.status(404).json({ error: 'Clip not found' });
  }
});

app.listen(PORT, () => console.log(`ClipDrop on port ${PORT}`));
