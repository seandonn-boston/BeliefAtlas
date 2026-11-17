#!/usr/bin/env bash
# Back up the BeliefAtlas database to a timestamped pg_dump file and keep the newest N.
#
#   DATABASE_URL=postgres://... scripts/ops/backup.sh
#
# Settings (environment):
#   DATABASE_URL   database to dump (required). BACKUP_DATABASE_URL wins if set, so a cron
#                  job can use a direct, non-pooled connection while the app uses the pooler.
#   BACKUP_DIR     where dumps go (default ./backups). Created with owner-only permissions.
#   BACKUP_KEEP    how many dumps to keep (default 7). Older ones are deleted.
#
# Output: $BACKUP_DIR/beliefatlas-YYYYMMDDTHHMMSSZ.dump in pg_dump's custom format (compressed,
# restorable table by table with pg_restore). The file is written under a temporary name and
# renamed only after pg_restore can read its table of contents, so a half-written dump never
# counts as the latest one.
#
# Dumps contain account data (hashed phone numbers, votes). Keep them off shared drives and
# out of git; this script drops a .gitignore into the backup directory for that reason.
# Needs pg_dump of the same major version as the server, or newer.
set -euo pipefail

url="${BACKUP_DATABASE_URL:-${DATABASE_URL:-}}"
dir="${BACKUP_DIR:-./backups}"
keep="${BACKUP_KEEP:-7}"

if [[ -z "$url" ]]; then
  echo "backup: set DATABASE_URL (or BACKUP_DATABASE_URL)" >&2
  exit 2
fi
if ! [[ "$keep" =~ ^[1-9][0-9]*$ ]]; then
  echo "backup: BACKUP_KEEP must be a whole number of at least 1" >&2
  exit 2
fi
for tool in pg_dump pg_restore; do
  command -v "$tool" >/dev/null || { echo "backup: $tool not found (install the PostgreSQL client)" >&2; exit 2; }
done

umask 077
mkdir -p "$dir"
[[ -f "$dir/.gitignore" ]] || printf '*\n' > "$dir/.gitignore"

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
final="$dir/beliefatlas-$stamp.dump"
partial="$final.partial"
trap 'rm -f "$partial"' EXIT

started=$(date +%s)
# --no-owner/--no-acl: restore into any database as whoever runs the restore (Neon, a laptop,
# a scratch database) without needing the original roles.
pg_dump --format=custom --compress=6 --no-owner --no-acl --file="$partial" --dbname="$url"
pg_restore --list "$partial" >/dev/null
mv "$partial" "$final"
trap - EXIT

size=$(wc -c < "$final" | tr -d ' ')
secs=$(( $(date +%s) - started ))
echo "{\"level\":\"info\",\"msg\":\"backup written\",\"time\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",\"file\":\"$final\",\"bytes\":$size,\"seconds\":$secs}"

# Keep the newest $keep dumps. Names sort by time, so the oldest come first.
# (A glob rather than find -printf or mapfile, so this also runs on macOS's bash 3.)
shopt -s nullglob
dumps=("$dir"/beliefatlas-*.dump)
excess=$(( ${#dumps[@]} - keep ))
if (( excess > 0 )); then
  for old in "${dumps[@]:0:excess}"; do
    rm -f -- "$old"
    echo "{\"level\":\"info\",\"msg\":\"old backup removed\",\"time\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",\"file\":\"$old\"}"
  done
fi
