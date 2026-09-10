/**
 * Minimal, safe backup for backend/data/overeno.sqlite.
 *
 * Copies the live database into backend/backups/overeno-<timestamp>.sqlite
 * using better-sqlite3's built-in `.backup()` — a proper SQLite online
 * backup (not a raw file copy), so it's safe to run while the server is
 * running and writing (WAL mode). Deliberately does NOT delete old
 * backups automatically — that's a retention-policy decision for
 * whoever's operating this, not something to guess at here.
 *
 * If the database doesn't exist yet (fresh install, never started the
 * server), this prints a clear message and exits cleanly — it does NOT
 * create an empty database just to "back it up".
 *
 * Usage: npm run backup:sqlite
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_PATH = path.join(DATA_DIR, 'overeno.sqlite');
const BACKUPS_DIR = path.join(__dirname, '..', 'backups');

if (!fs.existsSync(DB_PATH)) {
  console.log(`No database found at ${DB_PATH} — nothing to back up yet.`);
  console.log('This is normal on a fresh install before the server has been started once.');
  process.exit(0);
}

fs.mkdirSync(BACKUPS_DIR, { recursive: true });

// Timestamp with no characters that are awkward in filenames (colons in
// particular break on some filesystems/tools).
const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
const backupPath = path.join(BACKUPS_DIR, `overeno-${timestamp}.sqlite`);

console.log(`Backing up ${DB_PATH}`);
console.log(`       to  ${backupPath}`);

// Read-only connection — this script only ever reads the live database,
// never writes to it, so there's no risk of it corrupting/modifying
// production data even if something above this line were wrong.
const sourceDb = new Database(DB_PATH, { readonly: true });

try {
  // better-sqlite3's .backup() uses SQLite's own online backup API —
  // safe to run against a database that's actively being written to by
  // another process (the running server), unlike copying the file bytes
  // directly, which could grab an inconsistent snapshot mid-write.
  await sourceDb.backup(backupPath);
  const stats = fs.statSync(backupPath);
  console.log(`Backup complete: ${(stats.size / 1024).toFixed(1)} KB`);
  console.log('');
  console.log('Old backups are never deleted automatically — clean up');
  console.log(`${BACKUPS_DIR} yourself according to your own retention policy.`);
} finally {
  sourceDb.close();
}
