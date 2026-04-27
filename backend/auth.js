import { Router } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { v4 as uuidv4 } from 'uuid';
import { getDb } from './db.js';

const router = Router();

const JWT_SECRET = process.env.JWT_SECRET || 'audia-dev-secret-change-in-prod';
export const FREE_LIMIT = 3;

function currentMonth() {
  return new Date().toISOString().slice(0, 7);
}

function userResponse(user) {
  const month = currentMonth();
  const episodesUsed = user.month_reset_date === month ? user.episodes_used_this_month : 0;
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    tier: user.tier,
    episodesUsed,
    episodesLimit: user.tier === 'pro' ? null : FREE_LIMIT,
  };
}

export function verifyToken(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) return res.status(401).json({ error: 'Authentication required' });
  try {
    req.user = jwt.verify(auth.slice(7), JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}

export function optionalAuth(req, res, next) {
  const auth = req.headers.authorization;
  if (auth?.startsWith('Bearer ')) {
    try { req.user = jwt.verify(auth.slice(7), JWT_SECRET); } catch {}
  }
  next();
}

router.post('/register', async (req, res) => {
  const { email, password, name } = req.body || {};
  if (!email?.trim() || !password) return res.status(400).json({ error: 'Email and password are required' });
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });

  const db = getDb();
  const normalised = email.toLowerCase().trim();
  if (db.prepare('SELECT id FROM users WHERE email = ?').get(normalised)) {
    return res.status(409).json({ error: 'Email already registered' });
  }

  const hash = await bcrypt.hash(password, 10);
  const id = uuidv4();
  db.prepare('INSERT INTO users (id, email, password_hash, name) VALUES (?, ?, ?, ?)').run(
    id, normalised, hash, name?.trim() || null
  );

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  const token = jwt.sign({ id, email: normalised }, JWT_SECRET, { expiresIn: '30d' });
  res.status(201).json({ token, user: userResponse(user) });
});

router.post('/login', async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'Email and password are required' });

  const db = getDb();
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email.toLowerCase().trim());
  if (!user || !(await bcrypt.compare(password, user.password_hash))) {
    return res.status(401).json({ error: 'Invalid email or password' });
  }

  const month = currentMonth();
  if (user.month_reset_date !== month) {
    db.prepare('UPDATE users SET episodes_used_this_month = 0, month_reset_date = ? WHERE id = ?').run(month, user.id);
    user.episodes_used_this_month = 0;
    user.month_reset_date = month;
  }

  const token = jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ token, user: userResponse(user) });
});

router.get('/me', verifyToken, (req, res) => {
  const db = getDb();
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });

  const month = currentMonth();
  if (user.month_reset_date !== month) {
    db.prepare('UPDATE users SET episodes_used_this_month = 0, month_reset_date = ? WHERE id = ?').run(month, user.id);
    user.episodes_used_this_month = 0;
    user.month_reset_date = month;
  }

  res.json(userResponse(user));
});

export { router as authRouter };
