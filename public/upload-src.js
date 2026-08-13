import { FFmpeg } from '@ffmpeg/ffmpeg';
import { fetchFile, toBlobURL } from '@ffmpeg/util';

const WASM_BASE = 'https://pub-ae2fb61b74a2478ab22675a177d5c3e5.r2.dev/assets';

let ffmpegPromise = null;

export async function getFfmpeg() {
  if (!ffmpegPromise) {
    ffmpegPromise = (async () => {
      const ffmpeg = new FFmpeg();
      await ffmpeg.load({
        coreURL: await toBlobURL(`${WASM_BASE}/ffmpeg-core.js`, 'text/javascript'),
        wasmURL: await toBlobURL(`${WASM_BASE}/ffmpeg-core.wasm`, 'application/wasm'),
      });
      return ffmpeg;
    })();
  }
  return ffmpegPromise;
}

export async function sniffCodec(file) {
  const buf = new Uint8Array(await file.slice(0, 131072).arrayBuffer());
  let s = '';
  for (let i = 0; i < buf.length; i++) s += String.fromCharCode(buf[i]);
  const isHevc = /hev1|hvc1/.test(s);
  const isAvc = /avc1/.test(s);
  return { isHevc, isAvc, needsWork: isHevc || !isAvc };
}

export async function prepareForWeb(file, onProgress) {
  const { isHevc, isAvc, needsWork } = await sniffCodec(file);
  if (!needsWork) return file;

  if (file.size > 500 * 1024 * 1024) {
    throw new Error('File too large for browser convert (max 500MB). Re-export as H.264 in OBS.');
  }

  onProgress('loading converter…', 0);
  const ffmpeg = await getFfmpeg();
  const inputName = 'input' + (file.name.match(/\.\w+$/)?.[0] || '.mp4');
  const outputName = 'output.mp4';

  ffmpeg.on('progress', ({ progress }) => {
    const pct = Math.min(99, Math.round((progress || 0) * 100));
    onProgress(`converting to H.264… ${pct}%`, pct);
  });

  await ffmpeg.writeFile(inputName, await fetchFile(file));

  if (isAvc && !isHevc) {
    await ffmpeg.exec(['-i', inputName, '-c', 'copy', '-movflags', '+faststart', outputName]);
  } else {
    await ffmpeg.exec([
      '-i', inputName,
      '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '28',
      '-c:a', 'aac', '-b:a', '128k',
      '-movflags', '+faststart', '-pix_fmt', 'yuv420p',
      outputName,
    ]);
  }

  const data = await ffmpeg.readFile(outputName);
  await ffmpeg.deleteFile(inputName);
  await ffmpeg.deleteFile(outputName);

  const base = file.name.replace(/\.[^.]+$/, '');
  return new File([data.buffer], `${base}-web.mp4`, { type: 'video/mp4' });
}
