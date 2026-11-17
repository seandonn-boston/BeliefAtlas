// Consent, privacy and the gate in front of the vote engine. See each file for the rules:
//   context.ts  what a record knows about the request (GPC, region, surface, language)
//   ledger.ts   texts, the append-only records, current state, GPC opt-outs
//   gate.ts     voteWithConsent(): no answer counts before the 'answering' agreement
//   slices.ts   hiding small groups in aggregate breakdowns
//   sale.ts     the only query that may read person-level answers for a sale
//   request.ts  (server only) the context of the current request
export * from "./context";
export * from "./ledger";
export * from "./gate";
export * from "./slices";
export * from "./sale";
