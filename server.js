import express from 'express';
import { createRequire } from 'module';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json());

// Serve the built Vite app
app.use(express.static(path.join(__dirname, 'dist')));

// In-memory scheduled notifications: id → { fireAt, title, body, topicId, timeout }
const scheduled = {};

async function sendNtfy(topicId, title, body) {
  try {
    await fetch(`https://ntfy.sh/${topicId}`, {
      method: 'POST',
      headers: { Title: title, Priority: 'high', Tags: 'bell' },
      body,
    });
  } catch (_) {}
}

// Schedule a notification
app.post('/api/schedule', (req, res) => {
  const { id, fireAt, title, body, topicId } = req.body;
  if (!id || !fireAt || !topicId) return res.status(400).json({ error: 'missing fields' });

  // Cancel existing with same id
  if (scheduled[id]) {
    scheduled[id].forEach(t => clearTimeout(t));
    delete scheduled[id];
  }

  const followUps = req.body.followUps || [];
  scheduled[id] = [];

  const scheduleOne = (time, t, b) => {
    const ms = Math.max(0, time - Date.now());
    const handle = setTimeout(() => sendNtfy(topicId, t, b), ms);
    scheduled[id].push(handle);
  };

  scheduleOne(fireAt, title, body);
  followUps.forEach(f => scheduleOne(fireAt + f.extraMs, f.title, f.body));

  res.json({ ok: true });
});

// Cancel a scheduled notification
app.delete('/api/schedule/:id', (req, res) => {
  const { id } = req.params;
  if (scheduled[id]) {
    scheduled[id].forEach(t => clearTimeout(t));
    delete scheduled[id];
  }
  res.json({ ok: true });
});

// Fallback to index.html for SPA routing
app.get('*', (_, res) => res.sendFile(path.join(__dirname, 'dist', 'index.html')));

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Server running on port ${port}`));
