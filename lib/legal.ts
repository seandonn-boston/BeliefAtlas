// Flip LEGAL_DRAFT to false once a lawyer has reviewed /terms and /privacy. Until then both
// pages say they are drafts.
export const LEGAL_DRAFT = true;

// Shown on every page, every chart, every embed and share card, and carried in every data
// download and API answer: BeliefAtlas's figures are its users' opinions, nothing official.
// The translated versions live in messages/<lang>/common.json under "unofficial".
export const UNOFFICIAL_NOTICE = "Unofficial. Opinions of BeliefAtlas users, not official statistics, polls or law.";
export const LEGAL_UPDATED = "13 November 2026";
export const CONTACT_EMAIL = process.env.CONTACT_EMAIL ?? "[contact email]";
export const OPERATOR = process.env.OPERATOR_NAME ?? "the operator of BeliefAtlas";
// Recorded on each account at signup, so we know which terms someone agreed to. Change it
// whenever /terms or /privacy changes in substance.
export const TERMS_VERSION = "2026-11-13";

// Wherever a split includes seed votes (fictional launch answers, lib/provenance.ts), it says so
// (Sean, 20 Nov 2026). The translated versions live in messages/<lang>/common.json under "sample".
export const SAMPLE_ANSWERS_NOTE =
  "Includes sample answers made up by BeliefAtlas to get the site started. They aren't real people's opinions and will be removed.";
