-- W4: consent, privacy and demographics, on top of the Stage 2 contracts.
--
--   * A tap from an account that hasn't agreed to answering yet is held with the reason
--     'needs_consent' (the held-vote flow from 007), and counted once they agree.
--   * consent_texts carry a `draft` flag: every text stays a draft until a lawyer has reviewed
--     it, the same way lib/legal.ts marks /terms and /privacy.
--   * consent_records is append-only. The database refuses an update, and refuses a delete
--     except when the account itself is being deleted (the rows go with it).
--   * Version 1 of both texts, in English and Spanish.

-- ---------- Held votes waiting for consent ----------
alter table pending_votes drop constraint pending_votes_reason_check;
alter table pending_votes add constraint pending_votes_reason_check
  check (reason in ('needs_signup', 'limit_reached', 'needs_consent'));
-- A tap held for consent keeps what the person chose with it, so a "vote privately" tap is
-- counted as private once they agree (lib/consent/gate.ts claims these itself).
alter table pending_votes add column is_private boolean not null default false;
alter table pending_votes add column source text;

-- ---------- Draft marker on consent texts ----------
alter table consent_texts add column draft boolean not null default true;

-- ---------- Consent records are append-only ----------
create function consent_records_append_only() returns trigger language plpgsql as $$
begin
  if tg_op = 'UPDATE' then
    raise exception 'consent_records is append-only: record a new row instead of changing one';
  end if;
  -- A delete is only allowed as part of deleting the account (the foreign key cascades after
  -- the account row is gone).
  if exists (select 1 from accounts where id = old.account_id) then
    raise exception 'consent_records is append-only: rows are removed only with their account';
  end if;
  return old;
end $$;

create trigger consent_records_no_update before update on consent_records
  for each row execute function consent_records_append_only();
create trigger consent_records_no_delete before delete on consent_records
  for each row execute function consent_records_append_only();

-- Only versions that exist can be recorded, so a record always points at the exact words shown.
create index consent_texts_choice_version on consent_texts (choice, version);

-- The surface a choice was made on, kept short and plain.
alter table consent_records add constraint consent_records_surface_check
  check (surface ~ '^[a-z0-9_-]{1,32}$');
alter table consent_records add constraint consent_records_region_check
  check (region is null or region ~ '^([A-Z]{2}|\*)$');

-- ---------- Version 1 texts (drafts until a lawyer reviews them) ----------
insert into consent_texts (choice, version, lang, body, draft) values
('answering', '1', 'en',
'When you answer a question, BeliefAtlas keeps your answer, when you gave it, where you tapped it (for example a share link or an embed), and every later change. Your answers are beliefs, so we treat them as sensitive and ask you first.

We use your answers to count the results everyone sees and to build your own belief map. Results show only totals and percentages, and small groups are hidden so nobody can be picked out.

Any answer can be private: it still counts in the totals, but it is never shown with your name.

You can change or delete an answer, download everything we hold, and delete your account at any time in Settings. Agreeing here is not agreeing to sale: that is a separate choice, off unless you turn it on.', true),
('sale', '1', 'en',
'Optional. If you turn this on, your answers may be included in data that BeliefAtlas sells to researchers and other buyers, without your name, username or phone number.

It is off unless you turn it on, you never need it to answer questions, and you can turn it off at any time in Settings. Turning it off removes you from every sale from then on. If your browser sends a Global Privacy Control signal, we treat that as turning it off.

Sale is only possible where the law allows it and after legal review. Until then nothing is sold.', true),
('answering', '1', 'es',
'Cuando respondes una pregunta, BeliefAtlas guarda tu respuesta, cuándo la diste, dónde la tocaste (por ejemplo, un enlace compartido o un widget) y cada cambio posterior. Tus respuestas son creencias, así que las tratamos como datos sensibles y te pedimos permiso primero.

Usamos tus respuestas para contar los resultados que ve todo el mundo y para construir tu propio mapa de creencias. Los resultados solo muestran totales y porcentajes, y los grupos pequeños se ocultan para que nadie pueda ser identificado.

Cualquier respuesta puede ser privada: sigue contando en los totales, pero nunca se muestra con tu nombre.

Puedes cambiar o borrar una respuesta, descargar todo lo que guardamos y borrar tu cuenta cuando quieras en Ajustes. Aceptar aquí no es aceptar la venta: esa es una elección aparte, desactivada a menos que la actives.', true),
('sale', '1', 'es',
'Opcional. Si lo activas, tus respuestas pueden incluirse en datos que BeliefAtlas vende a investigadores y otros compradores, sin tu nombre, tu nombre de usuario ni tu número de teléfono.

Está desactivado a menos que lo actives, nunca lo necesitas para responder preguntas y puedes desactivarlo cuando quieras en Ajustes. Desactivarlo te saca de todas las ventas a partir de ese momento. Si tu navegador envía una señal de Control Global de Privacidad (GPC), lo tratamos como desactivarlo.

La venta solo es posible donde la ley lo permite y después de una revisión legal. Hasta entonces no se vende nada.', true);
