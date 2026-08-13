# ClipDrop

Private Streamable-style clip host on **your** Cloudflare R2 bucket.

## Deploy to Render (easiest — your R2 token is enough)

1. Push this folder to a GitHub repo (or use Render's manual deploy).
2. Go to [render.com](https://render.com) → **New → Web Service** → connect repo.
3. Set these environment variables:

| Variable | Value |
|---|---|
| `CLOUDFLARE_ACCOUNT_ID` | `a41b556e5cb967da7d49d43379f9662f` |
| `R2_ACCESS_KEY_ID` | your access key |
| `R2_SECRET_ACCESS_KEY` | your secret key |
| `R2_BUCKET_NAME` | `clips` |
| `R2_PUBLIC_URL` | `https://pub-ae2fb61b74a2478ab22675a177d5c3e5.r2.dev` |

4. Build: `npm install` · Start: `npm start`
5. After deploy, add your Render URL to R2 CORS (see below).

---

## Deploy to Cloudflare Workers (needs a different API token)

Your `cfat_…` token is **R2-only** — it can't deploy Workers. Create a new token:

Dashboard → **My Profile → API Tokens → Create Token** → use **Edit Cloudflare Workers** template (include R2 read/write).

Then:

```powershell
$env:CLOUDFLARE_API_TOKEN = "new-token-with-workers-permission"
echo "YOUR_R2_ACCESS_KEY" | npx wrangler secret put R2_ACCESS_KEY_ID
echo "YOUR_R2_SECRET" | npx wrangler secret put R2_SECRET_ACCESS_KEY
npm run deploy
```

Account ID is already in `wrangler.toml`.

---

## R2 CORS (required for browser uploads)

R2 → **clips** → Settings → CORS policy. Replace origin with your live site URL:

```json
[
  {
    "AllowedOrigins": ["https://YOUR-SITE-URL"],
    "AllowedMethods": ["PUT", "GET", "HEAD"],
    "AllowedHeaders": ["*"],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 3600
  }
]
```

---

## Local dev

```powershell
copy .dev.vars.example .dev.vars
# fill in R2 keys
npm install
npm start
```

Open http://localhost:3000 — add `http://localhost:3000` to CORS too.

