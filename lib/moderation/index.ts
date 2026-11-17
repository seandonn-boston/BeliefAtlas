// The moderation pipeline. `@/lib/moderation` is the one import for all of it:
//   sweep.ts        the few-second check when a question is asked: allow, hold or deny
//   screen.ts       names, subjects and the optional model the sweep uses
//   bans.ts         demerits and the escalating temporary bans they bring
//   reports.ts      reports from voters, hide pending review, the switched-off auto-remove
//   decisions.ts    what a moderator does with a question, and the queue they see
//   merge.ts        merging a repeat into the original, under a named vote rule
//   appeals.ts      appeals against removals, bans and demerits
//   manipulation.ts signals of coordinated voting, the only path to a permanent ban
export * from "./sweep";
export * from "./screen";
export * from "./bans";
export * from "./reports";
export * from "./decisions";
export * from "./merge";
export * from "./appeals";
export * from "./manipulation";
export { logDecision } from "./log";
