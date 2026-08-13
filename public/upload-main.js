import { FFmpeg } from '@ffmpeg/ffmpeg';
import { fetchFile, toBlobURL } from '@ffmpeg/util';
import { prepareForWeb, sniffCodec } from './upload-src.js';

window.uploadFile = async function uploadFile(file) {
  const row = document.createElement('div');
  row.className = 'upload-row';
  row.innerHTML = `
    <div class="top">
      <span class="name">${file.name}</span>
      <span class="status">preparing…</span>
    </div>
    <div class="bar"><div class="bar-fill"></div></div>
  `;
  document.getElementById('queue').prepend(row);
  const statusEl = row.querySelector('.status');
  const barFill = row.querySelector('.bar-fill');

  const setStatus = (text, pct) => {
    statusEl.textContent = text;
    if (pct != null) barFill.style.width = pct + '%';
  };

  try {
    let toUpload = file;
    const codec = await sniffCodec(file);
    if (codec.needsWork) {
      toUpload = await prepareForWeb(file, setStatus);
    }

    const res = await fetch('/api/upload-url', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename: toUpload.name, contentType: 'video/mp4' }),
    });
    if (!res.ok) throw new Error('Could not get upload URL');
    const { uploadUrl, watchUrl } = await res.json();

    setStatus('uploading…', 0);

    await new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('PUT', uploadUrl);
      xhr.setRequestHeader('Content-Type', 'video/mp4');
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) {
          const pct = Math.round((e.loaded / e.total) * 100);
          barFill.style.width = pct + '%';
          setStatus(`uploading… ${pct}%`, pct);
        }
      };
      xhr.onload = () => (xhr.status >= 200 && xhr.status < 300) ? resolve() : reject(new Error('Upload failed'));
      xhr.onerror = () => reject(new Error('Network error'));
      xhr.send(toUpload);
    });

    barFill.style.width = '100%';
    statusEl.textContent = 'done';
    statusEl.classList.add('done');
    const link = document.createElement('a');
    link.href = watchUrl;
    link.textContent = 'Open clip →';
    row.appendChild(link);
    window.loadClips();
  } catch (err) {
    statusEl.textContent = err.message;
    statusEl.classList.add('error');
  }
};
