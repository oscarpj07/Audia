import express from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { v4 as uuidv4 } from 'uuid';
import dotenv from 'dotenv';
import rateLimit from 'express-rate-limit';
import Stripe from 'stripe';
import { searchArticles } from './search.js';
import { generateScript } from './generate.js';
import { generateAudioSegments } from './voices.js';
import { stitchAudio } from './stitch.js';
import { initDB, getDB } from './db.js';
import { register, login, generateToken, getUserFromToken } from './auth.js';

dotenv.config({ path: path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.env') });

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const EPISODES_DIR = path.join(ROOT, 'episodes');

if (!fs.existsSync(EPISODES_DIR)) fs.mkdirSync(EPISODES_DIR, { recursive: true });

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || 'sk_test_dummy');

const app = express();
app.use(cors());
app.use(express.json());

// Rate limiting
const generateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  message: 'Too many requests, please try again later'
});

// Middleware: extract user from JWT
async function authMiddleware(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (token) {
    const user = await getUserFromToken(token);
    if (user) req.user = user;
  }
  next();
}

app.use(authMiddleware);

// Serve generated MP3s
app.use('/episodes', express.static(EPISODES_DIR));

// Serve frontend
app.get('/', (req, res) => {
  res.sendFile(path.join(ROOT, 'Podcast Studio.html'));
});

// ── Auth Endpoints ─────────────────────────────────────────────────────────
app.post('/api/auth/register', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

    const user = await register(email, password);
    const token = generateToken(user.id);
    res.json({ user, token });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

    const user = await login(email, password);
    const token = generateToken(user.id);
    res.json({ user, token });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/auth/me', (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
  res.json(req.user);
});

// ── Stripe Billing ─────────────────────────────────────────────────────────
app.post('/api/billing/checkout', async (req, res) => {
  try {
    if (!req.user) return res.status(401).json({ error: 'Unauthorized' });

    const plan = req.body.plan; // 'pro' or 'business'
    const prices = {
      pro: process.env.STRIPE_PRICE_PRO || 'price_1234567890',
      business: process.env.STRIPE_PRICE_BUSINESS || 'price_0987654321'
    };

    if (!prices[plan]) return res.status(400).json({ error: 'Invalid plan' });

    let customerId = req.user.stripe_customer_id;
    if (!customerId) {
      const customer = await stripe.customers.create({ email: req.user.email });
      customerId = customer.id;
      const db = await getDB();
      await db.run('UPDATE users SET stripe_customer_id = ? WHERE id = ?', [customerId, req.user.id]);
    }

    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      mode: 'subscription',
      line_items: [{ price: prices[plan], quantity: 1 }],
      success_url: `${process.env.FRONTEND_URL || 'http://localhost:3001'}/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.FRONTEND_URL || 'http://localhost:3001'}/billing`,
      metadata: { userId: req.user.id }
    });

    res.json({ checkoutUrl: session.url });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Webhook: stripe subscription updates
app.post('/api/billing/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  try {
    const event = stripe.webhooks.constructEvent(
      req.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET || 'whsec_test'
    );

    const db = await getDB();
    if (event.type === 'customer.subscription.updated' || event.type === 'customer.subscription.created') {
      const subscription = event.data.object;
      const userId = subscription.metadata?.userId;
      if (userId) {
        const plan = subscription.items.data[0]?.price?.lookup_key === 'pro' ? 'pro' : 'business';
        await db.run(
          'UPDATE users SET plan = ?, stripe_subscription_id = ? WHERE id = ?',
          [plan, subscription.id, userId]
        );
      }
    }

    if (event.type === 'customer.subscription.deleted') {
      const subscription = event.data.object;
      const userId = subscription.metadata?.userId;
      if (userId) {
        await db.run(
          'UPDATE users SET plan = ?, stripe_subscription_id = NULL WHERE id = ?',
          ['free', userId]
        );
      }
    }

    res.json({ received: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
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

// ── Freemium enforcement ───────────────────────────────────────────────────
async function checkEpisodeQuota(userId) {
  const db = await getDB();
  const user = await db.get('SELECT * FROM users WHERE id = ?', [userId]);

  if (user.plan !== 'free') return true; // Pro/Business unlimited

  const now = new Date();
  const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

  if (!user.reset_date || !user.reset_date.startsWith(currentMonth)) {
    // New month, reset counter
    await db.run(
      'UPDATE users SET episodes_this_month = 0, reset_date = ? WHERE id = ?',
      [currentMonth, userId]
    );
    return true;
  }

  if (user.episodes_this_month >= 3) return false; // Free: 3/month
  return true;
}

async function incrementEpisodeCount(userId) {
  const db = await getDB();
  await db.run(
    'UPDATE users SET episodes_this_month = episodes_this_month + 1 WHERE id = ?',
    [userId]
  );
}

// ── Generation endpoint ────────────────────────────────────────────────────
app.post('/api/generate', generateLimiter, async (req, res) => {
  try {
    if (!req.user) return res.status(401).json({ error: 'Unauthorized' });

    const { topic } = req.body || {};
    if (!topic?.trim()) return res.status(400).json({ error: 'topic is required' });

    const hasQuota = await checkEpisodeQuota(req.user.id);
    if (!hasQuota) return res.status(403).json({ error: 'Monthly episode limit reached. Upgrade to Pro.' });

    const episodeId = uuidv4();
    res.json({ episodeId });

    // Save to database and increment counter
    const db = await getDB();
    await db.run(
      'INSERT INTO episodes (id, user_id, title, topic) VALUES (?, ?, ?, ?)',
      [episodeId, req.user.id, topic.trim(), topic.trim()]
    );
    await incrementEpisodeCount(req.user.id);

    // Mock mode or real generation
    if (process.env.UI_MOCK === 'true') {
      runMock(episodeId, topic).catch(err => send(episodeId, { step: 'error', message: err.message }));
    } else {
      generateEpisode(episodeId, topic, req.user.id).catch(err =>
        send(episodeId, { step: 'error', message: err.message })
      );
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

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

  const outputPath = path.join(EPISODES_DIR, `${episodeId}.mp3`);
  const { execSync } = await import('child_process');
  execSync(`ffmpeg -f lavfi -i anullsrc=r=44100:cl=stereo -t 3 -q:a 9 -acodec libmp3lame "${outputPath}" -y`, { stdio: 'pipe' });

  const db = await getDB();
  const audioUrl = `/episodes/${episodeId}.mp3`;
  await db.run(
    'UPDATE episodes SET audio_url = ?, audio_file_path = ?, duration_seconds = ? WHERE id = ?',
    [audioUrl, outputPath, 3, episodeId]
  );

  const episode = {
    id: episodeId,
    topic: topic.trim(),
    audioUrl,
    createdAt: new Date().toISOString(),
    script: 'HOST1: This is a mock episode.\nHOST2: No API credits were used.'
  };

  send(episodeId, { step: 'done', episode });
  console.log(`[mock] ${episodeId} — "${topic}"`);
}

async function generateEpisode(episodeId, topic, userId) {
  const tempDir = path.join(EPISODES_DIR, `tmp_${episodeId}`);
  fs.mkdirSync(tempDir, { recursive: true });

  try {
    send(episodeId, { step: 'search', message: 'Searching for recent articles...' });
    const articles = await searchArticles(topic.trim());

    send(episodeId, { step: 'script', message: 'Claude is writing the script...' });
    const { script, format, formatLabel, speakerMap } = await generateScript(topic.trim(), articles);

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

    send(episodeId, { step: 'stitch', message: 'Stitching audio into MP3...' });
    const outputPath = path.join(EPISODES_DIR, `${episodeId}.mp3`);
    await stitchAudio(segments, outputPath, tempDir);

    try { fs.rmdirSync(tempDir); } catch {}

    const stats = fs.statSync(outputPath);
    const audioUrl = `/episodes/${episodeId}.mp3`;

    const db = await getDB();
    await db.run(
      'UPDATE episodes SET script = ?, audio_url = ?, audio_file_path = ?, duration_seconds = ? WHERE id = ?',
      [script, audioUrl, outputPath, Math.floor(stats.size / 128000), episodeId]
    );

    const episode = {
      id: episodeId,
      topic: topic.trim(),
      script,
      audioUrl,
      createdAt: new Date().toISOString()
    };

    send(episodeId, { step: 'done', episode });
    console.log(`[done] ${episodeId} — "${topic}"`);
  } catch (err) {
    const msg = err.response?.data ? JSON.stringify(err.response.data) : err.message;
    console.error(`[error] ${episodeId}:`, msg);
    send(episodeId, { step: 'error', message: msg });
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
  }
}

// ── Library: fetch user's episodes ────────────────────────────────────────
app.get('/api/episodes', async (req, res) => {
  try {
    if (!req.user) return res.status(401).json({ error: 'Unauthorized' });

    const db = await getDB();
    const episodes = await db.all(
      'SELECT id, title, topic, audio_url, duration_seconds, created_at FROM episodes WHERE user_id = ? ORDER BY created_at DESC',
      [req.user.id]
    );

    res.json(episodes || []);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/episodes/:id', async (req, res) => {
  try {
    if (!req.user) return res.status(401).json({ error: 'Unauthorized' });

    const db = await getDB();
    const ep = await db.get(
      'SELECT * FROM episodes WHERE id = ? AND user_id = ?',
      [req.params.id, req.user.id]
    );

    if (!ep) return res.status(404).json({ error: 'Not found' });
    res.json(ep);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Start ──────────────────────────────────────────────────────────────────
(async () => {
  await initDB();

  const PORT = process.env.PORT || 3001;
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Audia backend → http://0.0.0.0:${PORT}`);
    console.log(`Episodes folder: ${EPISODES_DIR}`);
  });
})();
