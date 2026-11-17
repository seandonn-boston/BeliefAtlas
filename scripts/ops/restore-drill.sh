#!/usr/bin/env bash
# Restore drill: prove the latest backup can actually be restored.
#
#   DATABASE_URL=postgres://... scripts/ops/restore-drill.sh [dump-file]
#
# Restores a dump (default: the newest beliefatlas-*.dump in BACKUP_DIR) into a new scratch
# database on the same server, checks that the main tables came back with sensible row
# counts, and drops the scratch database again, whether the drill passes or fails.
#
# Settings (environment):
#   DATABASE_URL        the live database (required). Used read-only, to compare row counts,
#                       and to create and drop the scratch database, so its role needs CREATEDB.
#                       RESTORE_DATABASE_URL wins if set, to drill on a different server.
#   BACKUP_DIR          where backup.sh writes dumps (default ./backups)
#   DRILL_DB            scratch database name (default beliefatlas_restore_drill_<time>). Must
#                       contain "restore_drill"; the drill refuses to touch any other name.
#   DRILL_ALLOW_EMPTY   set to 1 to accept a dump with no questions (a fresh install)
#
# Exit status: 0 when the restore and every check pass, 1 when a check fails, 2 on bad setup.
set -euo pipefail

url="${RESTORE_DATABASE_URL:-${DATABASE_URL:-}}"
dir="${BACKUP_DIR:-./backups}"
scratch="${DRILL_DB:-beliefatlas_restore_drill_$(date -u +%Y%m%d%H%M%S)}"

if [[ -z "$url" ]]; then
  echo "restore-drill: set DATABASE_URL (or RESTORE_DATABASE_URL)" >&2
  exit 2
fi
if ! [[ "$scratch" =~ ^[a-z0-9_]+$ && "$scratch" == *restore_drill* ]]; then
  echo "restore-drill: DRILL_DB must be lowercase letters, digits and underscores, and contain restore_drill" >&2
  exit 2
fi
for tool in pg_restore psql node; do
  command -v "$tool" >/dev/null || { echo "restore-drill: $tool not found" >&2; exit 2; }
done

dump="${1:-}"
if [[ -z "$dump" ]]; then
  shopt -s nullglob
  dumps=("$dir"/beliefatlas-*.dump)
  if (( ${#dumps[@]} == 0 )); then
    echo "restore-drill: no beliefatlas-*.dump files in $dir (run scripts/ops/backup.sh first)" >&2
    exit 2
  fi
  dump="${dumps[${#dumps[@]}-1]}"
fi
[[ -r "$dump" ]] || { echo "restore-drill: cannot read $dump" >&2; exit 2; }

# Swap the database name in the URL with Node's URL parser rather than string surgery, so
# query parameters (sslmode, channel_binding) survive. The URL travels in the environment,
# not on a command line where other users could see the password.
with_db() { DRILL_URL="$url" DRILL_NAME="$1" node -e 'const u = new URL(process.env.DRILL_URL); u.pathname = "/" + process.env.DRILL_NAME; process.stdout.write(u.toString())'; }
source_db="$(DRILL_URL="$url" node -e 'process.stdout.write(decodeURIComponent(new URL(process.env.DRILL_URL).pathname.slice(1)))')"
if [[ "$scratch" == "$source_db" ]]; then
  echo "restore-drill: the scratch database cannot be the live one" >&2
  exit 2
fi
scratch_url="$(with_db "$scratch")"

say() { echo "{\"level\":\"$1\",\"msg\":\"$2\",\"time\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"${3:+,$3}}"; }
psql_live() { psql "$url" -X -q -v ON_ERROR_STOP=1 -tA "$@"; }
psql_scratch() { psql "$scratch_url" -X -q -v ON_ERROR_STOP=1 -tA "$@"; }

cleanup() {
  psql_live -c "drop database if exists \"$scratch\" with (force)" >/dev/null 2>&1 \
    && say info "scratch database dropped" "\"database\":\"$scratch\"" \
    || say warn "could not drop scratch database; drop it by hand" "\"database\":\"$scratch\""
}

started=$(date +%s)
say info "restore drill starting" "\"dump\":\"$dump\",\"database\":\"$scratch\""
psql_live -c "create database \"$scratch\""
trap cleanup EXIT

# --exit-on-error: any failed statement fails the drill. Constraints and foreign keys are
# recreated after the data loads, so a dump with broken references fails here too.
pg_restore --no-owner --no-acl --exit-on-error --dbname="$scratch_url" "$dump"
restore_secs=$(( $(date +%s) - started ))
say info "dump restored" "\"seconds\":$restore_secs"

failures=0
fail() { failures=$((failures + 1)); say error "$1" "${2:-}"; }

exists() { [[ "$(psql_scratch -c "select to_regclass('public.$1') is not null")" == "t" ]]; }
count() { "$1" -c "select count(*) from public.$2" 2>/dev/null || echo "-1"; }

printf '\n%-16s %12s %12s\n' "table" "restored" "live now"
for table in migrations accounts questions votes vote_events; do
  if ! exists "$table"; then
    fail "table missing after restore" "\"table\":\"$table\""
    continue
  fi
  restored="$(count psql_scratch "$table")"
  live="$(count psql_live "$table")"
  printf '%-16s %12s %12s\n' "$table" "$restored" "$live"
  # The live database keeps changing after the dump was taken, so more rows live is normal
  # and fewer can follow account deletions. More rows in the dump than live is only an
  # error for migrations, where it would mean the dump came from a different database.
  if [[ "$table" == "migrations" && "$live" != "-1" && "$restored" -gt "$live" ]]; then
    fail "dump has migrations the live database does not" "\"restored\":$restored,\"live\":$live"
  elif [[ "$live" != "-1" && "$restored" -gt "$live" ]]; then
    say warn "dump has more rows than live (deletions since the dump?)" "\"table\":\"$table\",\"restored\":$restored,\"live\":$live"
  fi
done
echo

migrations="$(count psql_scratch migrations)"
questions="$(count psql_scratch questions)"
(( migrations > 0 )) || fail "no migrations recorded in the dump"
if (( questions <= 0 )) && [[ "${DRILL_ALLOW_EMPTY:-}" != "1" ]]; then
  fail "no questions in the dump (set DRILL_ALLOW_EMPTY=1 for a fresh install)"
fi

# Every migration in the dump should also be applied live: the dump is of this database.
latest="$(psql_scratch -c "select name from migrations order by name desc limit 1")"
if [[ -n "$latest" && "$(psql_live -c "select count(*) from migrations where name = '${latest//\'/\'\'}'")" != "1" ]]; then
  fail "the dump's newest migration is not applied live" "\"migration\":\"$latest\""
fi

# Every vote should point at a question and an account that came back with it.
orphans="$(psql_scratch -c "select count(*) from votes v where not exists (select 1 from questions q where q.id = v.question_id) or not exists (select 1 from accounts a where a.id = v.account_id)")"
[[ "$orphans" == "0" ]] || fail "votes without their question or account" "\"count\":$orphans"

total=$(( $(date +%s) - started ))
if (( failures > 0 )); then
  say error "restore drill failed" "\"failures\":$failures,\"seconds\":$total"
  exit 1
fi
say info "restore drill passed" "\"dump\":\"$dump\",\"migrations\":$migrations,\"questions\":$questions,\"seconds\":$total"
