// Rulebook hooks. The owner's rulebook (for moderators, for askers, for buyers) is being written
// separately; this is the one place its rules are named, so every merge, dismissal and denial
// records the id of the rule it was made under (question_merges.rule_id,
// duplicate_suspects.rule_id, questions.removed_rule, moderation_log.rule_id). When the rulebook
// is written, each id gets its full text for each audience, and old records already point at it.
//
// Ids are stable: never reuse or rename one. A changed rule is a new id.

export const RULEBOOK = [
  // Duplicates. The test is "does the data tell two different stories".
  { id: "dup_same_polarity", kind: "merge", title: "Same subject, same polarity: combine" },
  { id: "dup_inverted_polarity", kind: "merge", title: "Same subject, only the polarity differs: combine with answers flipped" },
  { id: "dup_different_subject", kind: "dismiss", title: "Different subjects, even two halves of one coin: keep apart" },
  // Approval of a reported or held question.
  { id: "keep_reviewed", kind: "approve", title: "Reviewed by a moderator and kept" },
  // Denials (removals).
  { id: "deny_not_yes_no", kind: "deny", title: "Can't be answered true or false" },
  { id: "deny_private_person", kind: "deny", title: "About a private person" },
  { id: "deny_hateful", kind: "deny", title: "Hateful" },
  { id: "deny_harassing", kind: "deny", title: "Harassing" },
  { id: "deny_spam", kind: "deny", title: "Spam or advertising" },
  { id: "deny_other", kind: "deny", title: "Other reason, explained in the removal" },
] as const;

export type Rule = (typeof RULEBOOK)[number];
export type RuleId = Rule["id"];
export type RuleKind = Rule["kind"];

export const isRuleId = (v: unknown): v is RuleId => RULEBOOK.some((r) => r.id === v);
export const ruleById = (id: string): Rule | undefined => RULEBOOK.find((r) => r.id === id);
export const rulesOfKind = (kind: RuleKind): Rule[] => RULEBOOK.filter((r) => r.kind === kind);

// The rule a denial falls under when the moderator didn't pick one: its harm, if any.
export function denialRule(harm: string | null | undefined): RuleId {
  const id = `deny_${harm}`;
  return isRuleId(id) ? id : "deny_other";
}
