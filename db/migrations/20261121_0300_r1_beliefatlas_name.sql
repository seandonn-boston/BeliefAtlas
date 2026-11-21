-- R1: the product is now BeliefAtlas (was BeliefAtlas; renamed 21 Nov 2026 because that name
-- belongs to a Russian APT28 malware family).
--
-- Applied migrations are never edited, so the product name stored in data is changed here:
--   * Consent texts: version 2 of each text is version 1 with the new name and nothing else.
--     A new version doesn't undo earlier agreements (lib/consent/ledger.ts); records keep
--     pointing at the exact words that were shown. Still drafts until a lawyer reviews them.
--   * The China region note.
-- The internal setting beliefatlas.seed_load keeps its old name on purpose (see lib/seed-data.ts).

insert into consent_texts (choice, version, lang, body, draft)
select choice, '2', lang, replace(body, 'BeliefAtlas', 'BeliefAtlas'), draft
  from consent_texts
 where version = '1'
on conflict (choice, version, lang) do nothing;

update regions set notes = replace(notes, 'BeliefAtlas', 'BeliefAtlas') where notes like '%BeliefAtlas%';
