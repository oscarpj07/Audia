import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, '..', 'audia.db');

let db;

export function getDb() {
  if (!db) {
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        email TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        name TEXT,
        tier TEXT NOT NULL DEFAULT 'free',
        stripe_customer_id TEXT,
        stripe_subscription_id TEXT,
        episodes_used_this_month INTEGER NOT NULL DEFAULT 0,
        month_reset_date TEXT NOT NULL DEFAULT (strftime('%Y-%m', 'now')),
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS episodes (
        id TEXT PRIMARY KEY,
        user_id TEXT REFERENCES users(id),
        topic TEXT NOT NULL,
        format TEXT,
        format_label TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        audio_url TEXT,
        file_size_bytes INTEGER,
        script TEXT,
        summary TEXT,
        sources TEXT,
        duration_seconds INTEGER
      );

      CREATE TABLE IF NOT EXISTS interest_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT REFERENCES users(id),
        topic TEXT NOT NULL,
        event_type TEXT NOT NULL DEFAULT 'generated',
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_episodes_user_id ON episodes(user_id);
      CREATE INDEX IF NOT EXISTS idx_episodes_created_at ON episodes(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_interest_user ON interest_events(user_id, created_at DESC);
    `);
  }
  return db;
}
