/**
 * One-off migration: reads the legacy backend/data/*.json files (if any)
 * and inserts their records into SQLite, skipping anything whose id
 * already exists in the database. Safe to run more than once — repeated
 * runs just report everything as a skipped duplicate.
 *
 * Usage: npm run migrate:json
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { db } from '../db/database.js'; // importing this also runs initSchema()
import { insertLead, leadExists } from '../db/repositories/leadsRepository.js';
import { insertBooking, bookingExists } from '../db/repositories/bookingsRepository.js';
import { insertVinCheck, vinCheckExists } from '../db/repositories/vinChecksRepository.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');

function readJsonArray(fileName) {
  const filePath = path.join(DATA_DIR, fileName);
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    if (!raw.trim()) return [];
    const data = JSON.parse(raw);
    return Array.isArray(data) ? data : [];
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    console.warn(`  Could not read ${fileName}: ${err.message}`);
    return [];
  }
}

function migrateOne(fileName, exists, insert) {
  const items = readJsonArray(fileName);
  let migrated = 0;
  let skipped = 0;

  for (const item of items) {
    if (!item || !item.id || exists(item.id)) {
      skipped++;
      continue;
    }
    insert(item);
    migrated++;
  }

  return { migrated, skipped };
}

console.log('Migrating JSON data into SQLite...');
console.log(`Database: ${db.name}`);
console.log('');

const leadsResult = migrateOne('leads.json', leadExists, insertLead);
const bookingsResult = migrateOne('bookings.json', bookingExists, insertBooking);
const vinChecksResult = migrateOne('vin_checks.json', vinCheckExists, insertVinCheck);

const skippedDuplicates = leadsResult.skipped + bookingsResult.skipped + vinChecksResult.skipped;

console.log(`leads migrated: ${leadsResult.migrated}`);
console.log(`bookings migrated: ${bookingsResult.migrated}`);
console.log(`vin checks migrated: ${vinChecksResult.migrated}`);
console.log(`skipped duplicates: ${skippedDuplicates}`);
