import crypto from 'crypto';
import { db } from '../database.js';

// A sensible, generic pre-purchase inspection checklist — not tied to
// any specific vehicle, just the common categories a physical
// inspection would cover. Order here is also the default sortOrder.
const DEFAULT_CHECKLIST_ITEMS = [
  { category: 'exterior', label: 'Body condition — rust, paint, panel gaps' },
  { category: 'exterior', label: 'Tires and wheels' },
  { category: 'exterior', label: 'Lights and glass' },
  { category: 'interior', label: 'Seats and upholstery' },
  { category: 'interior', label: 'Dashboard, electronics, infotainment' },
  { category: 'mechanical', label: 'Engine — visual inspection and noise' },
  { category: 'mechanical', label: 'Fluid levels and visible leaks' },
  { category: 'mechanical', label: 'Brakes' },
  { category: 'mechanical', label: 'Suspension and steering' },
  { category: 'documents', label: 'VIN plate matches documents' },
  { category: 'documents', label: 'Service history availability' },
  { category: 'test_drive', label: 'Test drive — general impression' }
];

// Allowed values for a checklist item's own finding — kept intentionally
// small and neutral (this is a physical-inspection note, not a risk
// score or a guarantee of anything).
export const CHECKLIST_ITEM_VALUES = ['ok', 'issue', 'not_checked'];

const INSERT_COLUMNS = ['id', 'jobId', 'category', 'label', 'value', 'comment', 'sortOrder', 'createdAt', 'updatedAt'];

const insertStmt = db.prepare(`
  INSERT INTO inspection_checklist_items (${INSERT_COLUMNS.join(', ')})
  VALUES (${INSERT_COLUMNS.map((c) => '@' + c).join(', ')})
`);
const selectByJobStmt = db.prepare('SELECT * FROM inspection_checklist_items WHERE jobId = ? ORDER BY sortOrder ASC');
const selectByIdStmt = db.prepare('SELECT * FROM inspection_checklist_items WHERE id = ?');
const updateStmt = db.prepare(`
  UPDATE inspection_checklist_items
  SET value = @value, comment = @comment, updatedAt = @updatedAt
  WHERE id = @id
`);

function generateItemId() {
  return 'checklistitem_' + crypto.randomBytes(6).toString('hex');
}

export function listChecklistItems(jobId) {
  return selectByJobStmt.all(jobId);
}

export function getChecklistItemById(id) {
  return selectByIdStmt.get(id) || null;
}

/**
 * Creates the default checklist set for a job — ONLY if it doesn't
 * already have any items (checked by the caller — see server.js's
 * POST /admin/inspection-jobs/:id/checklist/defaults). Deliberately not
 * a "reset" — calling this on a job that already has items is a no-op
 * from this function's own perspective (it just always inserts what
 * it's given; the emptiness check lives in the route handler so this
 * stays a simple, trustworthy primitive).
 */
export function createDefaultChecklistItems(jobId) {
  const now = new Date().toISOString();
  DEFAULT_CHECKLIST_ITEMS.forEach((item, index) => {
    insertStmt.run({
      id: generateItemId(),
      jobId,
      category: item.category,
      label: item.label,
      value: null,
      comment: null,
      sortOrder: index,
      createdAt: now,
      updatedAt: now
    });
  });
  return listChecklistItems(jobId);
}

/** Updates value/comment on a single checklist item — category/label/
 * sortOrder are structural and not editable through this function
 * (they come from the default set). Returns the updated item, or null
 * if no item has that id. */
export function updateChecklistItem(id, patch) {
  const existing = getChecklistItemById(id);
  if (!existing) return null;

  const merged = {
    id,
    value: patch.value !== undefined ? patch.value : existing.value,
    comment: patch.comment !== undefined ? patch.comment : existing.comment,
    updatedAt: new Date().toISOString()
  };

  updateStmt.run(merged);
  return getChecklistItemById(id);
}
