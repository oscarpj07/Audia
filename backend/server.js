import express from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { v4 as uuidv4 } from 'uuid';
import dotenv from 'dotenv';
import rateLimit from 'express-rate-limit';
import { searchArticles } from './search.js';
import { generateScript } from './generate.js';
import { generateAudioSegments } from './voices.js';
import { stitchAudio } from './stitch.js';
import { getDb } from './db.js';
import { authRouter, verifyToken, optionalAuth, FREE_LIMIT } from './auth.js';

dotenv.config({ path: path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.env') });

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const EPISODES_DIR = path.join(ROOT, 'episodes');

if (!fs.existsSync(EPISODES_DIR)) fs.mkdirSync(EPISODES_DIR, { recursive: true });

const STRIPE_SECRET = process.env.STRIPE_SECRET_KEY;
const STRIPE_PRICE_ID = process.env.STRIPE_PRO_PRICE_ID;
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;
const APP_URL = process.env.APP_URL || 'http://localhost:3001';

let stripe = null;
if (STRIPE_SECRET) {
  try {
    const { default: Stripe } = await import('stripe');
    stripe = new Stripe(STRIPE_SECRET);
  } catch { console.warn('[stripe] package not installed — billing disabled'); }
}

const app = express();
app.use(cors());

app.post('/api/billing/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  if (!stripe || !STRIPE_WEBHOOK_SECRET) return res.json({ received: true });

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('[stripe webhook] signature failed:', err.message);
    return res.status(400).send('Webhook signature verification failed');
  }

  const db = getDb();
  if (event.type === 'customer.subscription.created' || event.type === 'customer.subscription.updated') {
    const sub = event.data.object;
    if (sub.status === 'active') {
      db.prepare('UPDATE users SET tier = ?, stripe_subscription_id = ? WHERE stripe_customer_id = ?')
        .run('pro', sub.id, sub.customer);
    }
  }
  if (event.type === 'customer.subscription.deleted') {
    const sub = event.data.object;
    db.prepare('UPDATE users SET tier = ?, stripe_subscription_id = NULL WHERE stripe_customer_id = ?')
      .run('free', sub.customer);
  }

  res.json({ received: true });
});

app.use(express.json());

const globalLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 200, standardHeaders: true, legacyHeaders: false });
const generateLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  message: { error: 'Too many generation requests. Please wait before trying again.' }
});
app.use(globalLimiter);

app.use('/api/auth', authRouter);

app.post('/api/billing/create-checkout', verifyToken, async (req, res) => {
  if (!stripe || !STRIPE_PRICE_ID) return res.status(503).json({ error: 'Billing not configured' });
  try {
    const db = getDb();
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
    let customerId = user.stripe_customer_id;
    if (!customerId) {
      const customer = await stripe.customers.create({ email: user.email, metadata: { userId: user.id } });
      customerId = customer.id;
      db.prepare('UPDATE users SET stripe_customer_id = ? WHERE id = ?').run(customerId, user.id);
    }
    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      payment_method_types: ['card'],
      line_items: [{ price: STRIPE_PRICE_ID, quantity: 1 }],
      mode: 'subscription',
      success_url: `${APP_URL}/?upgraded=1`,
      cancel_url: `${APP_URL}/`,
      metadata: { userId: user.id },
    });
    res.json({ url: session.url });
  } catch (err) {
    console.error('[stripe checkout]', err.message);
    res.status(500).json({ error: 'Failed to create checkout session' });
  }
});

app.post('/api/billing/portal', verifyToken, async (req, res) => {
  if (!stripe) return res.status(503).json({ error: 'Billing not configured' });
  try {
    const db = getDb();
    const user = db.prepare('SELECT stripe_customer_id FROM users WHERE id = ?').get(req.user.id);
    if (!user?.stripe_customer_id) return res.status(400).json({ error: 'No billing account found' });
    const session = await stripe.billingPortal.sessions.create({
      customer: user.stripe_customer_id,
      return_url: APP_URL,
    });
    res.json({ url: session.url });
  } catch (err) {
    res.status(500).json({ error: 'Failed to open billing portal' });
  }
});

app.use('/episodes', express.static(EPISODES_DIR));
app.get('/', (req, res) => res.sendFile(path.join(ROOT, 'Podcast Studio.html')));

const progressClients = new Map();

app.get('/api/progress/:episodeId', (req, res) => {
  const { episodeId } = req.params;
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
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

async function runMock(episodeId, topic, userId) {
  const steps = [
    { step: 'search', message: 'Searching for recent articles...', ms: 400 },
    { step: 'script', message: 'Claude is writing the script...', ms: 800 },
    { step: 'voice', message: 'Generating voices (0 / 10 lines)...', voiceDone: 0, voiceTotal: 10, ms: 300 },
    { step: 'voice', message: 'Generating voices (5 / 10 lines)...', voiceDone: 5, voiceTotal: 10, ms: 300 },
    { step: 'voice', message: 'Generating voices (10 / 10 lines)...', voiceDone: 10, voiceTotal: 10, ms: 300 },
    { step: 'stitch', message: 'Stitching audio into MP3...', ms: 400 },
  ];
  for (const { ms, ...data } of steps) {
    send(episodeId, data);
    await new Promise(r => setTimeout(r, ms));
  }
  const outputPath = path.join(EPISODES_DIR, `${episodeId}.mp3`);
  const { execSync } = await import('child_process');
  execSync(`ffmpeg -f lavfi -i anullsrc=r=44100:cl=stereo -t 3 -q:a 9 -acodec libmp3lame "${outputPath}" -y`, { stdio: 'pipe' });
  const episode = {
    id: episodeId,
    topic: topic.trim(),
    format: 'explainer',
    formatLabel: 'Two-Host Explainer [MOCK]',
    createdAt: new Date().toISOString(),
    audioUrl: `/episodes/${episodeId}.mp3`,
    fileSizeBytes: fs.statSync(outputPath).size,
    durationSeconds: 3,
    sources: [{ title: 'Mock Article', url: 'https://example.com' }],
    script: 'ALEX: This is a mock episode.\nJAMIE: No API credits were used.',
  };
  const db = getDb();
  db.prepare(`
    INSERT INTO episodes (id, user_id, topic, format, format_label, created_at, audio_url, file_size_bytes, script, sources, duration_seconds)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(episodeId, userId || null, episode.topic, episode.format, episode.formatLabel,
    episode.createdAt, episode.audioUrl, episode.fileSizeBytes, episode.script,
    JSON.stringify(episode.sources), episode.durationSeconds);
  send(episodeId, { step: 'done', episode });
}

app.post('/api/generate', generateLimiter, optionalAuth, async (req, res) => {
  const { topic } = req.body || {};
  if (!topic?.trim()) return res.status(400).json({ error: 'Topic is required' });
  if (topic.trim().length > 300) return res.status(400).json({ error: 'Topic too long (max 300 chars)' });

  const db = getDb();
  const userId = req.user?.id || null;

  if (userId) {
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
    if (user && user.tier !== 'pro') {
      const month = new Date().toISOString().slice(0, 7);
      const used = user.month_reset_date === month ? user.episodes_used_this_month : 0;
      if (used >= FREE_LIMIT) {
        return res.status(402).json({
          error: 'Monthly limit reached',
          message: `You've used your ${FREE_LIMIT} free episodes this month. Upgrade to Pro for unlimited episodes.`,
          upgradeRequired: true,
          episodesUsed: used,
          episodesLimit: FREE_LIMIT,
        });
      }
    }
  }

  const episodeId = uuidv4();
  res.json({ episodeId });

  if (userId) {
    const month = new Date().toISOString().slice(0, 7);
    db.prepare(`
      UPDATE users
      SET episodes_used_this_month = CASE WHEN month_reset_date = ? THEN episodes_used_this_month + 1 ELSE 1 END,
          month_reset_date = ?
      WHERE id = ?
    `).run(month, month, userId);
  }

  if (process.env.UI_MOCK === 'true') {
    runMock(episodeId, topic, userId).catch(err => send(episodeId, { step: 'error', message: err.message }));
    return;
  }

  const tempDir = path.join(EPISODES_DIR, `tmp_${episodeId}`);
  fs.mkdirSync(tempDir, { recursive: true });

  (async () => {
    try {
      send(episodeId, { step: 'search', message: 'Searching for recent articles...' });
      const articles = await searchArticles(topic.trim());

      send(episodeId, { step: 'script', message: 'Claude is writing the script...' });
      const { script, format, formatLabel, speakerMap } = await generateScript(topic.trim(), articles);

      const totalLines = script.split('\n').filter(l => l.trim()).length;
      send(episodeId, { step: 'voice', message: `Generating voices (0 / ~${totalLines} lines)...`, voiceDone: 0, voiceTotal: totalLines });

      const segments = await generateAudioSegments(script, speakerMap, tempDir, (done, total) => {
        send(episodeId, { step: 'voice', message: `Generating voices (${done} / ${total} lines)...`, voiceDone: done, voiceTotal: total });
      });

      send(episodeId, { step: 'stitch', message: 'Stitching audio into MP3...' });
      const outputPath = path.join(EPISODES_DIR, `${episodeId}.mp3`);
      await stitchAudio(segments, outputPath, tempDir);

      try { fs.rmdirSync(tempDir); } catch {}

      const stats = fs.statSync(outputPath);
      const durationSeconds = Math.round(stats.size / 2000);

      const episode = {
        id: episodeId,
        topic: topic.trim(),
        format,
        formatLabel,
        createdAt: new Date().toISOString(),
        audioUrl: `/episodes/${episodeId}.mp3`,
        fileSizeBytes: stats.size,
        durationSeconds,
        sources: articles.map(a => ({ title: a.title, url: a.url })),
        script,
      };

      db.prepare(`
        INSERT INTO episodes (id, user_id, topic, format, format_label, created_at, audio_url, file_size_bytes, script, sources, duration_seconds)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(episodeId, userId, episode.topic, episode.format, episode.formatLabel,
        episode.createdAt, episode.audioUrl, episode.fileSizeBytes, episode.script,
        JSON.stringify(episode.sources), episode.durationSeconds);

      send(episodeId, { step: 'done', episode });

    } catch (err) {
      const detail = err.response?.data
        ? (typeof err.response.data === 'object' ? JSON.stringify(err.response.data) : err.response.data.toString())
        : '';
      const msg = `${err.message}${detail ? ' — ' + detail : ''}`;
      console.error(`[error] ${episodeId}:`, msg);
      send(episodeId, { step: 'error', message: msg });
      try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
    }
  })();
});

app.get('/api/episodes', optionalAuth, (req, res) => {
  const db = getDb();
  let rows;
  if (req.user?.id) {
    rows = db.prepare(`
      SELECT id, user_id, topic, format, format_label, created_at, audio_url, file_size_bytes, sources, duration_seconds
      FROM episodes WHERE user_id = ? ORDER BY created_at DESC LIMIT 100
    `).all(req.user.id);
  } else {
    rows = db.prepare(`
      SELECT id, topic, format, format_label, created_at, audio_url, file_size_bytes, sources, duration_seconds
      FROM episodes WHERE user_id IS NULL ORDER BY created_at DESC LIMIT 10
    `).all();
  }
  res.json(rows.map(e => ({ ...e, sources: JSON.parse(e.sources || '[]') })));
});

app.get('/api/episodes/:id', optionalAuth, (req, res) => {
  const db = getDb();
  const ep = db.prepare('SELECT * FROM episodes WHERE id = ?').get(req.params.id);
  if (!ep) return res.status(404).json({ error: 'Not found' });
  res.json({ ...ep, sources: JSON.parse(ep.sources || '[]') });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Podcast Studio backend → http://0.0.0.0:${PORT}`);
  console.log(`Episodes folder: ${EPISODES_DIR}`);
  if (STRIPE_SECRET) console.log('[stripe] billing enabled');
  else console.log('[stripe] billing disabled — set STRIPE_SECRET_KEY to enable');
  getDb();
});
