FROM node:20-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json transcode-server.js ./
RUN npm install --omit=dev production 2>/dev/null || npm install express dotenv @aws-sdk/client-s3

ENV PORT=3001
EXPOSE 3001
CMD ["node", "transcode-server.js"]
