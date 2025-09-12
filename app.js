// Frontend now calls our backend at /api

// Token helpers removed on frontend; backend holds the token
function getTokenRaw(){ return ''; }
function setTokenRaw(_t){}

async function replicateUpload(file) {
  const form = new FormData();
  form.append('content', file);
  const res = await fetch('/api/files', { method: 'POST', body: form });
  if (!res.ok) throw new Error(`Upload failed: ${res.status} ${await res.text()}`);
  const json = await res.json();
  return json.urls.get;
}

async function replicateRun(model, input) {
  const res = await fetch('/api/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model, input }) });
  if (!res.ok) throw new Error(await res.text());
  const json = await res.json();
  return json.output;
}

// Canvas helpers
const canvasStart = document.getElementById('canvasStart');
const canvasEnd = document.getElementById('canvasEnd');
const ctxStart = canvasStart.getContext('2d');
const ctxEnd = canvasEnd.getContext('2d');

async function drawImageOnCanvas(canvas, ctx, src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      const ratio = Math.min(canvas.width / img.width, canvas.height / img.height);
      const w = Math.round(img.width * ratio);
      const h = Math.round(img.height * ratio);
      const x = Math.floor((canvas.width - w) / 2);
      const y = Math.floor((canvas.height - h) / 2);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, x, y, w, h);
      resolve();
    };
    img.onerror = reject;
    img.src = src;
  });
}

function canvasToBlobURL(canvas, type = 'image/png', quality) {
  return new Promise((resolve) => {
    canvas.toBlob((blob) => {
      resolve(URL.createObjectURL(blob));
    }, type, quality);
  });
}

// No token UI on frontend anymore

// Upload local image to a canvas
function wireUpload(inputId, canvas, ctx) {
  const inp = document.getElementById(inputId);
  inp.addEventListener('change', async () => {
    if (!inp.files || !inp.files[0]) return;
    const url = URL.createObjectURL(inp.files[0]);
    await drawImageOnCanvas(canvas, ctx, url);
  });
}
wireUpload('uploadStart', canvasStart, ctxStart);
wireUpload('uploadEnd', canvasEnd, ctxEnd);
document.getElementById('clearStart').onclick = () => ctxStart.clearRect(0,0,canvasStart.width,canvasStart.height);
document.getElementById('clearEnd').onclick = () => ctxEnd.clearRect(0,0,canvasEnd.width,canvasEnd.height);

// Seedream-3 UI
document.getElementById('sd3Generate').addEventListener('click', async () => {
  try {
    const prompt = document.getElementById('sd3Prompt').value.trim();
    if (!prompt) return alert('Prompt obrigatório.');
    const ar = document.getElementById('sd3AR').value;
    const size = document.getElementById('sd3Size').value;
    const width = Number(document.getElementById('sd3W').value);
    const height = Number(document.getElementById('sd3H').value);
    const guidance_scale = Number(document.getElementById('sd3GS').value);
    const seedVal = document.getElementById('sd3Seed').value;

    const input = { prompt, aspect_ratio: ar, size, width, height, guidance_scale };
    if (seedVal !== '') input.seed = Number(seedVal);
    if (ar !== 'custom') { delete input.width; delete input.height; }
    const outputs = await replicateRun('bytedance/seedream-3', input);
    const outEl = document.getElementById('sd3Outputs');
    outEl.innerHTML = '';
    (Array.isArray(outputs) ? outputs : [outputs]).forEach(url => {
      const img = document.createElement('img');
      img.src = url; img.loading = 'lazy';
      img.onclick = () => window.open(url, '_blank');
      outEl.appendChild(img);
    });
  } catch (err) {
    alert(err.message);
  }
});

function takeFirstImageFrom(containerId) {
  const container = document.getElementById(containerId);
  const img = container.querySelector('img');
  return img ? img.src : null;
}

document.getElementById('sd3ToStart').onclick = async () => {
  const src = takeFirstImageFrom('sd3Outputs');
  if (!src) return alert('Gere uma imagem primeiro.');
  await drawImageOnCanvas(canvasStart, ctxStart, src);
};
document.getElementById('sd3ToEnd').onclick = async () => {
  const src = takeFirstImageFrom('sd3Outputs');
  if (!src) return alert('Gere uma imagem primeiro.');
  await drawImageOnCanvas(canvasEnd, ctxEnd, src);
};

// Nano Banana UI
let nbImageUrls = [];
document.getElementById('nbUpload').addEventListener('change', async (e) => {
  nbImageUrls = [];
  for (const f of e.target.files) {
    nbImageUrls.push(await replicateUpload(f));
  }
  alert(`${nbImageUrls.length} imagem(ns) carregadas.`);
});
document.getElementById('nbUseStart').onclick = async () => {
  const blobUrl = await canvasToBlobURL(canvasStart, 'image/png');
  const resp = await fetch(blobUrl);
  const file = new File([await resp.blob()], 'start.png', { type: 'image/png' });
  const url = await replicateUpload(file);
  nbImageUrls.push(url);
  alert('Start frame adicionado às imagens.');
};
document.getElementById('nbUseEnd').onclick = async () => {
  const blobUrl = await canvasToBlobURL(canvasEnd, 'image/png');
  const resp = await fetch(blobUrl);
  const file = new File([await resp.blob()], 'end.png', { type: 'image/png' });
  const url = await replicateUpload(file);
  nbImageUrls.push(url);
  alert('End frame adicionado às imagens.');
};

document.getElementById('nbEdit').addEventListener('click', async () => {
  try {
    const prompt = document.getElementById('nbPrompt').value.trim();
    if (!prompt) return alert('Prompt obrigatório.');
    const output_format = document.getElementById('nbFmt').value;
    const input = { prompt, image_input: nbImageUrls, output_format };
    const outputs = await replicateRun('google/nano-banana', input);
    const outEl = document.getElementById('nbOutputs');
    outEl.innerHTML = '';
    (Array.isArray(outputs) ? outputs : [outputs]).forEach(url => {
      const img = document.createElement('img');
      img.src = url; img.loading = 'lazy';
      img.onclick = () => window.open(url, '_blank');
      outEl.appendChild(img);
    });
  } catch (err) { alert(err.message); }
});
document.getElementById('nbToStart').onclick = async () => {
  const src = takeFirstImageFrom('nbOutputs');
  if (!src) return alert('Faça uma edição primeiro.');
  await drawImageOnCanvas(canvasStart, ctxStart, src);
};
document.getElementById('nbToEnd').onclick = async () => {
  const src = takeFirstImageFrom('nbOutputs');
  if (!src) return alert('Faça uma edição primeiro.');
  await drawImageOnCanvas(canvasEnd, ctxEnd, src);
};

// Seedance-1-lite Video

document.getElementById('sdvGenerate').addEventListener('click', async () => {
  try {
    const prompt = document.getElementById('sdvPrompt').value.trim();
    if (!prompt) return alert('Prompt obrigatório.');
    const duration = Number(document.getElementById('sdvDur').value);
    const resolution = document.getElementById('sdvRes').value;
    const aspect_ratio = document.getElementById('sdvAR').value;
    const seedVal = document.getElementById('sdvSeed').value;
    const camera_fixed = document.getElementById('sdvCamFixed').checked;

    // Upload start and end frames (required)
    const startBlobUrl = await canvasToBlobURL(canvasStart, 'image/png');
    const startBlob = await (await fetch(startBlobUrl)).blob();
    if (!startBlob || startBlob.size === 0) return alert('Defina o Start frame antes de gerar o vídeo.');
    const image = await replicateUpload(new File([startBlob], 'start.png', { type: 'image/png' }));

    const endBlobUrl = await canvasToBlobURL(canvasEnd, 'image/png');
    const endBlob = await (await fetch(endBlobUrl)).blob();
    if (!endBlob || endBlob.size === 0) return alert('Defina o End frame antes de gerar o vídeo.');
    const last_frame_image = await replicateUpload(new File([endBlob], 'end.png', { type: 'image/png' }));

    const input = { prompt, duration, resolution, aspect_ratio, camera_fixed, image, last_frame_image };
    if (seedVal !== '') input.seed = Number(seedVal);
    const outputs = await replicateRun('bytedance/seedance-1-lite', input);
    const outEl = document.getElementById('sdvOutputs');
    outEl.innerHTML = '';
    (Array.isArray(outputs) ? outputs : [outputs]).forEach(url => {
      const video = document.createElement('video');
      video.src = url; video.controls = true; video.muted = true; video.loop = true; video.playsInline = true;
      outEl.appendChild(video);
    });
  } catch (err) { alert(err.message); }
});


