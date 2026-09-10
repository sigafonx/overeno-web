// Per-agent prompt templates for the 5 "wave 1" agents (see
// agentRegistry.js). Each export is a function (input) -> { system,
// user } via basePrompts.js's buildPrompt(). Every prompt:
//   - states the agent's specific role;
//   - describes exactly what input data it receives;
//   - requires cautious, hedged wording;
//   - forbids inventing facts not present in the input;
//   - requires separating stated facts from the agent's own inferences;
//   - instructs the model to return ONLY the specified JSON shape.
//
// None of these are executed against a real model yet — see
// aiClient.js's mock provider — but the shape is exactly what a real
// provider call would receive/return, so wiring one in later is a
// change to aiClient.js only, not here.

import { buildSystemPrompt, formatInputForPrompt } from './basePrompts.js';

// Shared closing instructions every agent prompt repeats verbatim —
// kept in one place so the "don't invent facts" / "JSON only" rules
// can't drift between agents as more are added later.
function jsonOutputRules(schemaDescription) {
  return (
    `\n\nCRITICAL RULES:\n` +
    `- Only use information present in the input below. If something isn't in the ` +
    `input, do not guess or invent it — say it's unknown/not provided instead.\n` +
    `- Clearly separate facts stated in the input from your own inferences or ` +
    `suggestions (e.g. "the input states X" vs "this could suggest Y").\n` +
    `- This is a demo/mock environment in this step — if the input marks VIN data ` +
    `as demo/not verified, your output must not describe it as an official or ` +
    `verified vehicle history check.\n` +
    `- Respond with ONLY a single JSON object matching exactly this shape, no ` +
    `other text before or after it:\n${schemaDescription}`
  );
}

export function listingAnalysisPrompt(input) {
  return {
    system: buildSystemPrompt('Listing Analysis — reviewing a vehicle listing/report context for red flags'),
    user:
      `Your role: review the report context below (vehicle listing/VIN-check/booking ` +
      `data an admin is preparing a report from) and flag anything that looks ` +
      `inconsistent, vague, underpriced, or worth a closer look. You are analyzing ` +
      `TEXT/STRUCTURED DATA only — you have not seen any photos.\n\n` +
      `Input (report context):\n${formatInputForPrompt(input)}` +
      jsonOutputRules(
        `{\n  "redFlags": [string, ...],\n  "missingInfo": [string, ...],\n  ` +
        `"sellerQuestions": [string, ...],\n  "confidence": "low" | "medium" | "high",\n  ` +
        `"summary": string\n}`
      )
  };
}

export function riskScoringPrompt(input) {
  return {
    system: buildSystemPrompt('Risk Scoring — suggesting a risk level for a vehicle purchase, for a human to confirm'),
    user:
      `Your role: based on the report context below, suggest a risk score (0-100, ` +
      `higher = riskier) and risk level. This is a SUGGESTION for a human admin to ` +
      `confirm or override — never a final, automatic decision.\n\n` +
      `Input (report context):\n${formatInputForPrompt(input)}` +
      jsonOutputRules(
        `{\n  "score": number (0-100),\n  "riskLevel": "low" | "medium" | "high",\n  ` +
        `"riskFactors": [string, ...],\n  "protectiveFactors": [string, ...],\n  ` +
        `"explanation": string\n}`
      )
  };
}

export function reportWriterPrompt(input) {
  return {
    system: buildSystemPrompt('Report Writer — drafting report section prose for a human to review and edit'),
    user:
      `Your role: draft prose for report sections using the structured context below. ` +
      `Write in a neutral, factual tone suitable for a customer-facing report. This is ` +
      `a FIRST DRAFT the admin will review and edit — not final copy, and it must not ` +
      `be sent to any customer before that review happens. Only draft sections that make ` +
      `sense given the input (don't invent sections not supported by the context) — a ` +
      `sectionKey should be one of the keys already present in the report's own ` +
      `"sections" list in the input, since those are the only ones the admin can apply ` +
      `this draft into.\n\n` +
      `Input (report context):\n${formatInputForPrompt(input)}` +
      jsonOutputRules(
        `{\n  "sections": [{"sectionKey": string, "title": string, "content": string}, ...],\n  ` +
        `"summary": string,\n  "verdict": string\n}`
      )
  };
}

export function buyerAdvisorPrompt(input) {
  return {
    system: buildSystemPrompt('Buyer Advisor — drafting buyer guidance for a human to review before it reaches a customer'),
    user:
      `Your role: based on the report context below, draft a recommendation, next ` +
      `steps, negotiation points, and questions to ask the seller. Keep everything ` +
      `specific to this listing/vehicle, not generic advice that could apply to any ` +
      `car.\n\n` +
      `Input (report context):\n${formatInputForPrompt(input)}` +
      jsonOutputRules(
        `{\n  "recommendation": "consider" | "inspect_first" | "avoid",\n  ` +
        `"nextSteps": [string, ...],\n  "negotiationPoints": [string, ...],\n  ` +
        `"questionsForSeller": [string, ...]\n}`
      )
  };
}

export function vinRiskExplanationPrompt(input) {
  return {
    system: buildSystemPrompt('VIN Risk Explanation — explaining VIN check risk signals in plain language for a human to review'),
    user:
      `Your role: explain the VIN check data in the input below in plain language a ` +
      `non-expert buyer could understand. If the input marks the VIN result as demo/` +
      `not verified data, your explanation must say so explicitly and must not present ` +
      `it as an official vehicle history report.\n\n` +
      `Input (report context, including vinCheck data if available):\n${formatInputForPrompt(input)}` +
      jsonOutputRules(
        `{\n  "vinSummary": string,\n  "riskExplanation": string,\n  "limitations": [string, ...]\n}`
      )
  };
}

// Keyed lookup so orchestrator.js can go from agentName -> prompt builder
// without a fragile string-transform (e.g. "guessing" that
// "vin_risk_explanation" becomes "vinRiskExplanationPrompt").
export const PROMPT_BUILDERS = {
  listing_analysis: listingAnalysisPrompt,
  risk_scoring: riskScoringPrompt,
  report_writer: reportWriterPrompt,
  buyer_advisor: buyerAdvisorPrompt,
  vin_risk_explanation: vinRiskExplanationPrompt
};
