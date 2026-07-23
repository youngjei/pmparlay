#!/usr/bin/env bash
# Restores a staging dump into a disposable database and verifies key data counts.
set -Eeuo pipefail
umask 077

container="${STAGING_POSTGRES_CONTAINER:-legwork-postgres}"
source_database="${STAGING_DATABASE_NAME:-legwork_sepolia_staging}"
postgres_user="${STAGING_POSTGRES_USER:-legwork}"
script_dir="$(cd -P -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
backup_dir="$script_dir/../.context/backups"
restore_prefix='legwork_restore_rehearsal_'
restore_database=''

die() {
  printf 'staging-restore-rehearsal: %s\n' "$*" >&2
  exit 1
}

usage() {
  printf 'Usage: %s [dump-file]\n' "${0##*/}" >&2
  exit 2
}

cleanup() {
  local status=$?
  trap - EXIT

  if [[ -n "$restore_database" ]]; then
    if ! docker exec "$container" dropdb -U "$postgres_user" --if-exists --force "$restore_database"; then
      printf 'staging-restore-rehearsal: failed to drop disposable database %q; remove it manually.\n' "$restore_database" >&2
      status=1
    else
      printf 'Dropped disposable restore database: %s\n' "$restore_database"
    fi
  fi

  exit "$status"
}
trap cleanup EXIT

[[ $# -le 1 ]] || usage
[[ -n "$container" ]] || die 'STAGING_POSTGRES_CONTAINER must not be empty.'
[[ -n "$source_database" ]] || die 'STAGING_DATABASE_NAME must not be empty.'
[[ "$source_database" == 'legwork_sepolia_staging' ]] || die 'STAGING_DATABASE_NAME must be legwork_sepolia_staging.'
[[ -n "$postgres_user" ]] || die 'STAGING_POSTGRES_USER must not be empty.'
[[ "$source_database" != "$restore_prefix"* ]] || die 'Refusing a disposable rehearsal database as the source.'

command -v docker >/dev/null 2>&1 || die 'docker is required.'
command -v shasum >/dev/null 2>&1 || die 'shasum is required.'
docker inspect --type container "$container" >/dev/null 2>&1 || die "Container '$container' does not exist or is not accessible."
[[ "$(docker inspect --format '{{.State.Running}}' "$container")" == 'true' ]] || die "Container '$container' is not running."

if ! docker exec "$container" psql -X -v ON_ERROR_STOP=1 -U "$postgres_user" -d postgres -Atc \
  'SELECT datname FROM pg_database' | grep -Fxq "$source_database"; then
  die "Source database '$source_database' does not exist or cannot be inspected."
fi

mkdir -p "$backup_dir"
chmod 700 "$backup_dir"
backup_dir="$(cd -P "$backup_dir" && pwd)"

if [[ $# -eq 1 ]]; then
  requested_dump="$1"
  dump_dir="$(cd -P -- "$(dirname -- "$requested_dump")" 2>/dev/null && pwd)" || die "Dump directory does not exist: $requested_dump"
  dump_file="$dump_dir/$(basename -- "$requested_dump")"
  [[ "$dump_dir" == "$backup_dir" ]] || die "Dump must be inside $backup_dir"
else
  shopt -s nullglob
  dump_file=''
  for candidate in "$backup_dir"/*.dump; do
    [[ -f "$candidate" && ! -L "$candidate" ]] || continue
    if [[ -z "$dump_file" || "$candidate" -nt "$dump_file" ]]; then
      dump_file="$candidate"
    fi
  done
  shopt -u nullglob
  [[ -n "$dump_file" ]] || die "No .dump files found in $backup_dir"
fi

[[ -f "$dump_file" && ! -L "$dump_file" ]] || die "Dump is not a regular file: $dump_file"
[[ "${dump_file##*/}" == *.dump ]] || die "Dump must use the .dump extension: $dump_file"
checksum_file="$dump_file.sha256"
[[ -f "$checksum_file" && ! -L "$checksum_file" ]] || die "Dump checksum is missing: $checksum_file"
(cd "$backup_dir" && shasum -a 256 -c "$(basename -- "$checksum_file")") >/dev/null || die 'Dump checksum validation failed.'
docker exec -i "$container" pg_restore --list <"$dump_file" >/dev/null || die 'Dump archive failed pg_restore validation.'

active_connections="$(docker exec "$container" psql -X -v ON_ERROR_STOP=1 -U "$postgres_user" -d postgres -Atc \
  "SELECT count(*) FROM pg_stat_activity WHERE datname = '$source_database'")"
[[ "$active_connections" == '0' ]] || die "Content verification requires a quiescent source database; found $active_connections active connection(s)."

if [[ "${STAGING_RESTORE_REHEARSAL_CONFIRM:-}" != 'RESTORE' ]]; then
  if [[ ! -t 0 ]]; then
    die 'Refusing non-interactive restore rehearsal. Set STAGING_RESTORE_REHEARSAL_CONFIRM=RESTORE after reviewing the dump.'
  fi
  read -r -p "Restore '$dump_file' into a disposable database and verify it? Type RESTORE: " confirmation
  [[ "$confirmation" == 'RESTORE' ]] || die 'Restore rehearsal cancelled.'
fi

restore_database="${restore_prefix}$(date -u +%Y%m%d%H%M%S)_$$"
[[ "$restore_database" == "$restore_prefix"* && "$restore_database" != "$source_database" ]] || die 'Unsafe restore database name generated.'

printf 'Restore rehearsal: source=%s dump=%s restore=%s\n' "$source_database" "$dump_file" "$restore_database"
docker exec "$container" createdb -U "$postgres_user" "$restore_database"
docker exec -i "$container" pg_restore -U "$postgres_user" --exit-on-error --no-owner --no-privileges --dbname="$restore_database" <"$dump_file"

source_migrations="$(docker exec "$container" psql -X -v ON_ERROR_STOP=1 -U "$postgres_user" -d "$source_database" -Atc "SELECT name || ':' || coalesce(checksum, '<missing>') FROM schema_migrations ORDER BY name")"
restore_migrations="$(docker exec "$container" psql -X -v ON_ERROR_STOP=1 -U "$postgres_user" -d "$restore_database" -Atc "SELECT name || ':' || coalesce(checksum, '<missing>') FROM schema_migrations ORDER BY name")"
[[ "$source_migrations" == "$restore_migrations" ]] || die 'schema_migrations differs between the source and restore databases.'

source_tables="$(docker exec "$container" psql -X -v ON_ERROR_STOP=1 -U "$postgres_user" -d "$source_database" -Atc \
  "SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> 'schema_migrations' ORDER BY tablename")"
restore_tables="$(docker exec "$container" psql -X -v ON_ERROR_STOP=1 -U "$postgres_user" -d "$restore_database" -Atc \
  "SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> 'schema_migrations' ORDER BY tablename")"
[[ "$source_tables" == "$restore_tables" ]] || die 'Public table inventory differs between the source and restore databases.'

while IFS= read -r table; do
  [[ -n "$table" ]] || continue
  [[ "$table" =~ ^[a-z_][a-z0-9_]*$ ]] || die "Unsafe table identifier: $table"
  source_count="$(docker exec "$container" psql -X -v ON_ERROR_STOP=1 -U "$postgres_user" -d "$source_database" -Atc "SELECT count(*) FROM public.$table")"
  restore_count="$(docker exec "$container" psql -X -v ON_ERROR_STOP=1 -U "$postgres_user" -d "$restore_database" -Atc "SELECT count(*) FROM public.$table")"
  [[ "$source_count" == "$restore_count" ]] || die "Row count mismatch for $table: source=$source_count restore=$restore_count"
  source_fingerprint="$(docker exec "$container" psql -X -v ON_ERROR_STOP=1 -U "$postgres_user" -d "$source_database" -Atc "SELECT md5(coalesce(string_agg(row_json, E'\\n' ORDER BY row_json), '')) FROM (SELECT row_to_json(value)::text AS row_json FROM public.$table AS value) AS rows")"
  restore_fingerprint="$(docker exec "$container" psql -X -v ON_ERROR_STOP=1 -U "$postgres_user" -d "$restore_database" -Atc "SELECT md5(coalesce(string_agg(row_json, E'\\n' ORDER BY row_json), '')) FROM (SELECT row_to_json(value)::text AS row_json FROM public.$table AS value) AS rows")"
  [[ "$source_fingerprint" == "$restore_fingerprint" ]] || die "Content mismatch for $table"
  printf 'Verified %s rows and content: %s\n' "$table" "$source_count"
done <<<"$source_tables"

archive_hash="$(shasum -a 256 "$dump_file" | awk '{print $1}')"
proof_file="$dump_file.restore-verified"
proof_temp="$proof_file.$$.tmp"
printf '%s:%s\n' "$source_database" "$archive_hash" >"$proof_temp"
chmod 600 "$proof_temp"
mv -f -- "$proof_temp" "$proof_file"

printf 'Restore rehearsal passed; attestation: %s. The disposable database will now be dropped.\n' "$proof_file"
