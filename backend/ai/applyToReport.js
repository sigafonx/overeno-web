import { getReportById, updateReportSummary } from '../db/repositories/reportsRepository.js';
import { listSections, updateSection } from '../db/repositories/reportSectionsRepository.js';

// ---------------------------------------------------------------------------
// The ONLY place AI agent output is allowed to reach a report's actual
// content. Called exclusively from server.js's POST /admin/ai/runs/:id/apply
// route, which itself refuses to call this unless the run's status is
// 'completed' AND approvedAt is set (never for a rejected or still-
// pending run) — see that route for the enforcement, this file assumes
// it's already been checked and just does the mapping.
//
// Per-agent mapping (matches this step's spec exactly):
//   report_writer        -> replaces matching report_sections' content
//                            (it drafted the section from scratch)
//   risk_scoring          -> sets reports.score / reports.riskLevel
//   buyer_advisor          -> appends to the "seller_questions" and
//                            "final_verdict" sections (augments, doesn't
//                            replace — those sections may already have
//                            admin-written content)
//   listing_analysis        -> appends to the "listing_risks" section
//   vin_risk_explanation    -> appends to the "vin_result" section
//
// Every function here is defensive about sections that don't exist on
// a given report (e.g. a vin_basic_report has no "listing_risks"
// section) — it skips that piece and reports it as skipped, never
// throws, so a partial apply is still a successful, informative result.
// ---------------------------------------------------------------------------

function appendToSectionIfExists(reportId, sectionKey, heading, textToAppend) {
  const sections = listSections(reportId);
  const section = sections.find((s) => s.sectionKey === sectionKey);
  if (!section) {
    return { sectionKey, applied: false, reason: `This report has no "${sectionKey}" section.` };
  }

  const block = `[AI-drafted, ${heading} — reviewed and approved by admin before being added]\n${textToAppend}`;
  const existing = section.content || '';
  const newContent = existing.trim() ? `${existing}\n\n${block}` : block;

  updateSection(section.id, { title: section.title, content: newContent });
  return { sectionKey, applied: true };
}

function replaceSectionIfExists(reportId, sectionKey, title, content) {
  const sections = listSections(reportId);
  const section = sections.find((s) => s.sectionKey === sectionKey);
  if (!section) {
    return { sectionKey, applied: false, reason: `This report has no "${sectionKey}" section.` };
  }
  updateSection(section.id, { title: title || section.title, content });
  return { sectionKey, applied: true };
}

function bulletList(items) {
  if (!Array.isArray(items) || items.length === 0) return '(none)';
  return items.map((item) => `- ${item}`).join('\n');
}

function applyReportWriter(reportId, output) {
  const results = (output.sections || []).map((s) =>
    replaceSectionIfExists(reportId, s.sectionKey, s.title, s.content)
  );

  // summary/verdict go on the report itself, not a section — always
  // attempted regardless of which sections did/didn't exist.
  updateReportSummary(reportId, {
    summary: output.summary !== undefined ? output.summary : undefined,
    verdict: output.verdict !== undefined ? output.verdict : undefined
  });
  results.push({ sectionKey: '(report.summary)', applied: true });
  results.push({ sectionKey: '(report.verdict)', applied: true });

  return results;
}

function applyRiskScoring(reportId, output) {
  updateReportSummary(reportId, {
    score: output.score !== undefined ? output.score : undefined,
    riskLevel: output.riskLevel !== undefined ? output.riskLevel : undefined
  });
  return [
    { sectionKey: '(report.score)', applied: output.score !== undefined },
    { sectionKey: '(report.riskLevel)', applied: output.riskLevel !== undefined }
  ];
}

function applyBuyerAdvisor(reportId, output) {
  const results = [];

  if (Array.isArray(output.questionsForSeller) && output.questionsForSeller.length > 0) {
    results.push(appendToSectionIfExists(reportId, 'seller_questions', 'Buyer Advisor', bulletList(output.questionsForSeller)));
  }

  const verdictParts = [];
  if (output.recommendation) verdictParts.push(`Recommendation: ${output.recommendation}`);
  if (Array.isArray(output.nextSteps) && output.nextSteps.length > 0) verdictParts.push(`Next steps:\n${bulletList(output.nextSteps)}`);
  if (Array.isArray(output.negotiationPoints) && output.negotiationPoints.length > 0) verdictParts.push(`Negotiation points:\n${bulletList(output.negotiationPoints)}`);
  if (verdictParts.length > 0) {
    results.push(appendToSectionIfExists(reportId, 'final_verdict', 'Buyer Advisor', verdictParts.join('\n\n')));
  }

  return results;
}

function applyListingAnalysis(reportId, output) {
  const parts = [];
  if (Array.isArray(output.redFlags) && output.redFlags.length > 0) parts.push(`Red flags:\n${bulletList(output.redFlags)}`);
  if (Array.isArray(output.missingInfo) && output.missingInfo.length > 0) parts.push(`Missing information:\n${bulletList(output.missingInfo)}`);
  if (Array.isArray(output.sellerQuestions) && output.sellerQuestions.length > 0) parts.push(`Questions for seller:\n${bulletList(output.sellerQuestions)}`);

  if (parts.length === 0) {
    return [{ sectionKey: 'listing_risks', applied: false, reason: 'Output had no redFlags/missingInfo/sellerQuestions to add.' }];
  }
  return [appendToSectionIfExists(reportId, 'listing_risks', 'Listing Analysis', parts.join('\n\n'))];
}

function applyVinRiskExplanation(reportId, output) {
  const parts = [];
  if (output.vinSummary) parts.push(output.vinSummary);
  if (output.riskExplanation) parts.push(output.riskExplanation);
  if (Array.isArray(output.limitations) && output.limitations.length > 0) parts.push(`Limitations:\n${bulletList(output.limitations)}`);

  if (parts.length === 0) {
    return [{ sectionKey: 'vin_result', applied: false, reason: 'Output had no vinSummary/riskExplanation/limitations to add.' }];
  }
  return [appendToSectionIfExists(reportId, 'vin_result', 'VIN Risk Explanation', parts.join('\n\n'))];
}

const APPLY_HANDLERS = {
  report_writer: applyReportWriter,
  risk_scoring: applyRiskScoring,
  buyer_advisor: applyBuyerAdvisor,
  listing_analysis: applyListingAnalysis,
  vin_risk_explanation: applyVinRiskExplanation
};

/**
 * Applies an approved run's output to its linked report. Callers (see
 * server.js) are responsible for confirming the run is `completed` and
 * `approvedAt` is set BEFORE calling this — this function itself does
 * not re-check that, on purpose, so it stays a pure "do the mapping"
 * function with a single responsibility. Throws if the run's
 * entityType isn't "report", or its report no longer exists, or there's
 * no apply handler for its agentName.
 *
 * Returns an array of { sectionKey, applied, reason? } — one entry per
 * field the agent's output tried to contribute, so the caller can show
 * the admin exactly what landed and what was skipped (e.g. because the
 * target section doesn't exist on this particular report).
 */
export function applyRunToReport(run) {
  if (run.entityType !== 'report') {
    throw new Error(`Cannot apply a run with entityType "${run.entityType}" to a report — only entityType "report" runs support apply.`);
  }
  const report = getReportById(run.entityId);
  if (!report) {
    throw new Error(`Report "${run.entityId}" no longer exists — cannot apply.`);
  }

  const handler = APPLY_HANDLERS[run.agentName];
  if (!handler) {
    throw new Error(`No apply logic registered for agent "${run.agentName}".`);
  }

  let output;
  try {
    output = JSON.parse(run.outputJson);
  } catch {
    throw new Error('Run outputJson could not be parsed — cannot apply.');
  }

  return handler(run.entityId, output);
}
