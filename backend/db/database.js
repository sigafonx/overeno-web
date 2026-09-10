import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { initSchema } from './schema.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_PATH = path.join(DATA_DIR, 'overeno.sqlite');

fs.mkdirSync(DATA_DIR, { recursive: true });

const dbFileExistedBefore = fs.existsSync(DB_PATH);

export const db = new Database(DB_PATH);

// WAL mode lets admin reads (list/CSV export) run concurrently with a
// POST write instead of blocking on each other — exactly the concurrency
// problem the JSON-file storage couldn't handle.
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

initSchema(db);

export { DB_PATH, dbFileExistedBefore };
