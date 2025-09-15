// Simple Express backend proxying Replicate with env token (ESM)
import dotenv from 'dotenv';
import express from 'express';
import path from 'path';
import multer from 'multer';
import { fileURLToPath } from 'url';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const upload = multer();

const REPLICATE_API_BASE = 'https://api.replicate.com/v1';
// No environment token support; require user-provided token via header

app.use(express.json({ limit: '10mb' }));

// Static files (serve current directory)
app.use(express.static(path.join(__dirname)));

// Health
app.get('/api/health', (_req, res) => res.json({ ok: true }));

// Check token validity (lightweight)
app.get('/api/check-token', async (req, res) => {
  try {
    const userToken = req.headers['x-replicate-token'];
    if (!userToken) return res.status(401).json({ ok: false, error: 'Missing Replicate token' });
    const r = await fetch(`${REPLICATE_API_BASE}/account`, {
      headers: { Authorization: `Bearer ${userToken}` }
    });
    // 200 means valid; anything else propagate
    const text = await r.text();
    if (!r.ok) return res.status(r.status).send(text || 'Invalid token');
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err.message || err) });
  }
});

// Upload file to Replicate /v1/files
app.post('/api/files', upload.single('content'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file' });
    const userToken = req.headers['x-replicate-token'];
    if (!userToken) return res.status(401).json({ error: 'Missing Replicate token' });
    const form = new FormData();
    const blob = new Blob([req.file.buffer], { type: req.file.mimetype || 'application/octet-stream' });
    form.append('content', blob, req.file.originalname || 'upload.bin');

    const bearer = `Bearer ${userToken}`;
    const r = await fetch(`${REPLICATE_API_BASE}/files`, {
      method: 'POST',
      headers: { Authorization: bearer },
      body: form
    });
    const json = await r.json();
    if (!r.ok) return res.status(r.status).json(json);
    res.json(json);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: String(err.message || err) });
  }
});

// Create and wait for a prediction to finish
app.post('/api/run', async (req, res) => {
  try {
    const userToken = req.headers['x-replicate-token'];
    if (!userToken) return res.status(401).json({ error: 'Missing Replicate token' });
    const { model, version, input } = req.body || {};
    if ((!model && !version) || !input) return res.status(400).json({ error: 'model or version and input are required' });

    // Use model-scoped endpoint if model is provided; otherwise use versioned predictions
    const endpoint = model
      ? `${REPLICATE_API_BASE}/models/${model}/predictions`
      : `${REPLICATE_API_BASE}/predictions`;
    const payload = model ? { input } : { version, input };

    const bearer = `Bearer ${userToken}`;
    const create = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Authorization': bearer, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const created = await create.json();
    if (!create.ok) return res.status(create.status).json(created);

    let url = created.urls.get;
    let status = created.status;
    let last = created;
    const startedAt = Date.now();
    const timeoutMs = 5 * 60 * 1000;
    while (status === 'starting' || status === 'processing') {
      if (Date.now() - startedAt > timeoutMs) return res.status(504).json({ error: 'Timeout waiting prediction' });
      await new Promise(r => setTimeout(r, 1500));
      const r = await fetch(url, { headers: { Authorization: bearer } });
      last = await r.json();
      status = last.status;
    }
    if (status !== 'succeeded') return res.status(500).json(last);
    res.json({ output: last.output, prediction: last });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: String(err.message || err) });
  }
});

// Optional: pass-through GET for a prediction id
app.get('/api/predictions/:id', async (req, res) => {
  try {
    const userToken = req.headers['x-replicate-token'];
    if (!userToken) return res.status(401).json({ error: 'Missing Replicate token' });
    const r = await fetch(`${REPLICATE_API_BASE}/predictions/${req.params.id}`, { headers: { Authorization: `Bearer ${userToken}` } });
    const json = await r.json();
    res.status(r.status).json(json);
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server listening on http://localhost:${PORT}`));


