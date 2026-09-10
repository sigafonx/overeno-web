import crypto from 'crypto';
import { db } from '../database.js';

export const SECTION_KEYS = [
  'overview', 'vehicle_data', 'vin_result', 'listing_risks', 'odometer_risk',
  'accident_risk', 'seller_questions', 'physical_inspection_recommendations',
  'price_negotiation', 'final_verdict', 'disclaimer'
];

const SECTION_TITLES = {
  overview: 'Přehled',
  vehicle_data: 'Údaje o vozidle',
  vin_result: 'Výsledek VIN kontroly',
  listing_risks: 'Rizika inzerátu',
  odometer_risk: 'Riziko stočeného tachometru',
  accident_risk: 'Riziko nehodové historie',
  seller_questions: 'Otázky na prodejce',
  physical_inspection_recommendations: 'Doporučení pro fyzickou prohlídku',
  price_negotiation: 'Vyjednávání o ceně',
  final_verdict: 'Závěrečné hodnocení',
  disclaimer: 'Právní upozornění'
};

/** Which sections get auto-created for each reportType — order here is
 * also the default sortOrder. Anything not in this map (e.g. a future
 * inspection_report) simply gets no default sections; the admin can
 * still add nothing automatically, but the report itself still exists. */
const DEFAULT_SECTIONS_BY_REPORT_TYPE = {
  vin_basic_report: [
    'overview', 'vehicle_data', 'vin_result', 'odometer_risk', 'accident_risk',
    'seller_questions', 'physical_inspection_recommendations', 'final_verdict', 'disclaimer'
  ],
  manual_car_review: [
    'overview', 'listing_risks', 'seller_questions', 'price_negotiation',
    'physical_inspection_recommendations', 'final_verdict', 'disclaimer'
  ]
};

// Used by the draft_ready / report_ready status-transition checks in
// server.js — kept here (not duplicated there) since this file is the
// one place that already knows what a "section" is.
export const DRAFT_READY_REQUIRED_SECTION_KEYS = ['overview', 'final_verdict', 'disclaimer'];

const SECTION_COLUMNS = ['id', 'reportId', 'sectionKey', 'title', 'content', 'sortOrder', 'createdAt', 'updatedAt'];

const insertStmt = db.prepare(`
  INSERT INTO report_sections (${SECTION_COLUMNS.join(', ')})
  VALUES (${SECTION_COLUMNS.map((c) => '@' + c).join(', ')})
`);
const selectByReportStmt = db.prepare('SELECT * FROM report_sections WHERE reportId = ? ORDER BY sortOrder ASC');
const selectByIdStmt = db.prepare('SELECT * FROM report_sections WHERE id = ?');
const deleteByReportStmt = db.prepare('DELETE FROM report_sections WHERE reportId = ?');
const updateContentStmt = db.prepare('UPDATE report_sections SET title = @title, content = @content, updatedAt = @updatedAt WHERE id = @id');
const updateSortOrderStmt = db.prepare('UPDATE report_sections SET sortOrder = ?, updatedAt = ? WHERE id = ?');

function generateSectionId() {
  return 'reportsection_' + crypto.randomBytes(6).toString('hex');
}

/** Creates the default section set for a reportType (see the map above).
 * Content starts as an empty string (never null) so every consumer can
 * treat "no content yet" the same way, without a null check. Safe to
 * call on a report that already has sections — see resetDefaultSections()
 * below, which deletes first — this function itself does NOT check for
 * existing sections, callers decide that. */
export function createDefaultSections(reportId, reportType) {
  const keys = DEFAULT_SECTIONS_BY_REPORT_TYPE[reportType] || [];
  const now = new Date().toISOString();

  keys.forEach((key, index) => {
    insertStmt.run({
      id: generateSectionId(),
      reportId,
      sectionKey: key,
      title: SECTION_TITLES[key] || key,
      content: '',
      sortOrder: index,
      createdAt: now,
      updatedAt: now
    });
  });

  return listSections(reportId);
}

export function listSections(reportId) {
  return selectByReportStmt.all(reportId);
}

export function getSection(id) {
  return selectByIdStmt.get(id) || null;
}

/** Updates title/content on a single section — anything omitted from
 * `payload` keeps its current value. Returns the updated section, or
 * null if no section has that id. */
export function updateSection(id, payload) {
  const existing = getSection(id);
  if (!existing) return null;

  const merged = {
    id,
    title: payload.title !== undefined ? payload.title : existing.title,
    content: payload.content !== undefined ? payload.content : existing.content,
    updatedAt: new Date().toISOString()
  };

  updateContentStmt.run(merged);
  return getSection(id);
}

/** Re-numbers sortOrder to match the position of each id in `orderedIds`
 * (0-based). Callers are responsible for making sure every id actually
 * belongs to `reportId` first (see the route handler in server.js) —
 * this function trusts its input and just writes the new order. Returns
 * the sections in their new order. */
export function reorderSections(reportId, orderedIds) {
  const now = new Date().toISOString();
  orderedIds.forEach((id, index) => {
    updateSortOrderStmt.run(index, now, id);
  });
  return listSections(reportId);
}

/** Wipes every existing section for this report and recreates the
 * default set for reportType from scratch — a genuine reset, not a
 * "fill in anything missing." Any prior edits to section content are
 * lost; the admin UI confirms with the user before calling this. */
export function resetDefaultSections(reportId, reportType) {
  deleteByReportStmt.run(reportId);
  return createDefaultSections(reportId, reportType);
}
