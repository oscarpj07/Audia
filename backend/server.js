import express from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { v4 as uuidv4 } from 'uuid';
import dotenv from 'dotenv';
import { searchArticles } from './search.js';
import { generateScript } from './generate.js';
import { generateAudioSegments } from './voices.js';
import { stitchAudio } from './stitch.js';

dotenv.config({ path: path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.env') });

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

const EPISODES_DIR = path.join(ROOT, 'episodes');
const HISTORY_FILE = path.join(ROOT, 'episodes.json');

if (!fs.existsSync(EPISODES_DIR)) fs.mkdirSync(EPISODES_DIR, { recursive: true });
if (!fs.existsSync(HISTORY_FILE)) fs.writeFileSync(HISTORY_FILE, '[]');

function loadHistory() {
  try { return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf-8')); }
  catch { return []; }
}

function saveHistory(history) {
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2));
}

const app = express();
app.use(cors());
app.use(express.json());

// Serve generated MP3s
app.use('/episodes', express.static(EPISODES_DIR));

// Serve frontend
app.get('/', (req, res) => {
  res.sendFile(path.join(ROOT, 'Podcast Studio.html'));
});

// ── SSE progress tracking ──────────────────────────────────────────────────
const progressClients = new Map();

app.get('/api/progress/:episodeId', (req, res) => {
  const { episodeId } = req.params;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  // Send a heartbeat so the browser doesn't close the connection
  const heartbeat = setInterval(() => res.write(': ping\n\n'), 15000);

  progressClients.set(episodeId, res);

  req.on('close', () => {
    clearInterval(heartbeat);
    progressClients.delete(episodeId);
  });
});

function send(episodeId, data) {
  const client = progressClients.get(episodeId);
  if (client) client.write(`data: ${JSON.stringify(data)}\n\n`);
}

// ── UI_MOCK: instant fake episode, zero API calls ──────────────────────────
async function runMock(episodeId, topic) {
  const steps = [
    { step: 'search', message: 'Searching for recent articles...', ms: 400 },
    { step: 'script', message: 'Claude is writing the script...', ms: 800 },
    { step: 'voice',  message: 'Generating voices (0 / 10 lines)...', voiceDone: 0, voiceTotal: 10, ms: 300 },
    { step: 'voice',  message: 'Generating voices (5 / 10 lines)...', voiceDone: 5, voiceTotal: 10, ms: 300 },
    { step: 'voice',  message: 'Generating voices (10 / 10 lines)...', voiceDone: 10, voiceTotal: 10, ms: 300 },
    { step: 'stitch', message: 'Stitching audio into MP3...', ms: 400 }
  ];

  for (const { ms, ...data } of steps) {
    send(episodeId, data);
    await new Promise(r => setTimeout(r, ms));
  }

  // Use a pre-existing MP3 if one exists, otherwise generate a 3-second silent one
  const outputPath = path.join(EPISODES_DIR, `${episodeId}.mp3`);
  const { execSync } = await import('child_process');
  execSync(`ffmpeg -f lavfi -i anullsrc=r=44100:cl=stereo -t 3 -q:a 9 -acodec libmp3lame "${outputPath}" -y`, { stdio: 'pipe' });

  const episode = {
    id: episodeId,
    topic: topic.trim(),
    format: 'debate',
    formatLabel: 'Two-Host Debate [MOCK]',
    createdAt: new Date().toISOString(),
    audioUrl: `/episodes/${episodeId}.mp3`,
    fileSizeBytes: fs.statSync(outputPath).size,
    sources: [
      { title: 'Mock Article 1 — AI in Finance', url: 'https://example.com/1' },
      { title: 'Mock Article 2 — Investing Trends', url: 'https://example.com/2' }
    ],
    summary: `An AI-generated exploration of "${topic}" — Alex and Jamie break down the key ideas, surprising facts, and real-world implications in a natural back-and-forth conversation.`,
    script: 'HOST1: This is a mock episode.\nHOST2: No API credits were used.'
  };

  const history = loadHistory();
  history.unshift(episode);
  saveHistory(history);

  send(episodeId, { step: 'done', episode });
  console.log(`[mock] ${episodeId} — "${topic}"`);
}

// ── Generation endpoint ────────────────────────────────────────────────────
app.post('/api/generate', async (req, res) => {
  const { topic } = req.body || {};
  if (!topic?.trim()) return res.status(400).json({ error: 'topic is required' });

  const episodeId = uuidv4();
  // Respond immediately with the episodeId so the client can open the SSE stream
  res.json({ episodeId });

  // UI_MOCK=true → instant fake episode, zero credits
  if (process.env.UI_MOCK === 'true') {
    runMock(episodeId, topic).catch(err => send(episodeId, { step: 'error', message: err.message }));
    return;
  }

  const tempDir = path.join(EPISODES_DIR, `tmp_${episodeId}`);
  fs.mkdirSync(tempDir, { recursive: true });

  (async () => {
    try {
      // Step 1: Web search
      send(episodeId, { step: 'search', message: 'Searching for recent articles...' });
      const articles = await searchArticles(topic.trim());

      // Step 2: Script generation
      send(episodeId, { step: 'script', message: 'Claude is writing the script...' });
      const { script, format, formatLabel, speakerMap } = await generateScript(topic.trim(), articles);

      // Step 3: ElevenLabs TTS
      const totalLines = script.split('\n').filter(l => l.trim()).length;
      send(episodeId, {
        step: 'voice',
        message: `Generating voices (0 / ~${totalLines} lines)...`,
        voiceDone: 0,
        voiceTotal: totalLines
      });

      const segments = await generateAudioSegments(script, speakerMap, tempDir, (done, total) => {
        send(episodeId, {
          step: 'voice',
          message: `Generating voices (${done} / ${total} lines)...`,
          voiceDone: done,
          voiceTotal: total
        });
      });

      // Step 4: FFmpeg stitch
      send(episodeId, { step: 'stitch', message: 'Stitching audio into MP3...' });
      const outputPath = path.join(EPISODES_DIR, `${episodeId}.mp3`);
      await stitchAudio(segments, outputPath, tempDir);

      // Clean up temp dir
      try { fs.rmdirSync(tempDir); } catch {}

      const stats = fs.statSync(outputPath);
      const episode = {
        id: episodeId,
        topic: topic.trim(),
        format,
        formatLabel,
        createdAt: new Date().toISOString(),
        audioUrl: `/episodes/${episodeId}.mp3`,
        fileSizeBytes: stats.size,
        sources: articles.map(a => ({ title: a.title, url: a.url })),
        script
      };

      const history = loadHistory();
      history.unshift(episode);
      saveHistory(history);

      send(episodeId, { step: 'done', episode });
      console.log(`[done] ${episodeId} — "${topic}"`);

    } catch (err) {
      const detail = err.response?.data
        ? (typeof err.response.data === 'object'
            ? JSON.stringify(err.response.data)
            : err.response.data.toString())
        : '';
      const msg = `${err.message}${detail ? ' — ' + detail : ''}`;
      console.error(`[error] ${episodeId}:`, msg);
      send(episodeId, { step: 'error', message: msg });
      try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
    }
  })();
});

// ── Episode history ────────────────────────────────────────────────────────
app.get('/api/episodes', (_req, res) => {
  const history = loadHistory().map(e => ({
    id: e.id,
    topic: e.topic,
    format: e.format,
    formatLabel: e.formatLabel,
    createdAt: e.createdAt,
    audioUrl: e.audioUrl,
    fileSizeBytes: e.fileSizeBytes,
    sources: e.sources
    // script omitted from list to keep payload small
  }));
  res.json(history);
});

app.get('/api/episodes/:id', (req, res) => {
  const ep = loadHistory().find(e => e.id === req.params.id);
  if (!ep) return res.status(404).json({ error: 'Not found' });
  res.json(ep);
});

// ── Start ──────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Podcast Studio backend → http://0.0.0.0:${PORT}`);
  console.log(`Episodes folder: ${EPISODES_DIR}`);
});
