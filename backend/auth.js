import jwt from 'jsonwebtoken';
import bcrypt from 'bcrypt';
import { v4 as uuid } from 'uuid';
import { getDB } from './db.js';

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-in-production';

export async function register(email, password) {
  const db = await getDB();
  const id = uuid();
  const hashedPassword = await bcrypt.hash(password, 10);

  try {
    await db.run(
      'INSERT INTO users (id, email, password) VALUES (?, ?, ?)',
      [id, email, hashedPassword]
    );
    return { id, email, plan: 'free' };
  } catch (err) {
    throw new Error('Email already exists');
  }
}

export async function login(email, password) {
  const db = await getDB();
  const user = await db.get('SELECT * FROM users WHERE email = ?', [email]);

  if (!user) throw new Error('User not found');

  const validPassword = await bcrypt.compare(password, user.password);
  if (!validPassword) throw new Error('Invalid password');

  return user;
}

export function generateToken(userId) {
  return jwt.sign({ userId }, JWT_SECRET, { expiresIn: '7d' });
}

export function verifyToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch (err) {
    return null;
  }
}

export async function getUserFromToken(token) {
  const decoded = verifyToken(token);
  if (!decoded) return null;

  const db = await getDB();
  return await db.get('SELECT * FROM users WHERE id = ?', [decoded.userId]);
}
