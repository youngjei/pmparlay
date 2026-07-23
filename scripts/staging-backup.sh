#!/usr/bin/env bash
# Creates a local, portable custom-format dump for the staging database.
set -Eeuo pipefail
umask 077

container="${STAGING_POSTGRES_CONTAINER:-legwork-postgres}"
database="${STAGING_DATABASE_NAME:-legwork_sepolia_staging}"
postgres_user="${STAGING_POSTGRES_USER:-legwork}"
script_dir="$(cd -P -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
backup_dir="$script_dir/../.context/backups"

die() {
  printf 'staging-backup: %s\n' "$*" >&2
  exit 1
}

[[ -n "$container" ]] || die 'STAGING_POSTGRES_CONTAINER must not be empty.'
[[ -n "$database" ]] || die 'STAGING_DATABASE_NAME must not be empty.'
[[ "$database" == 'legwork_sepolia_staging' ]] || die 'STAGING_DATABASE_NAME must be legwork_sepolia_staging.'
[[ -n "$postgres_user" ]] || die 'STAGING_POSTGRES_USER must not be empty.'
[[ "$database" != legwork_restore_rehearsal_* ]] || die 'Refusing a disposable rehearsal database as a backup source.'

command -v docker >/dev/null 2>&1 || die 'docker is required.'
command -v shasum >/dev/null 2>&1 || die 'shasum is required.'
docker inspect --type container "$container" >/dev/null 2>&1 || die "Container '$container' does not exist or is not accessible."
[[ "$(docker inspect --format '{{.State.Running}}' "$container")" == 'true' ]] || die "Container '$container' is not running."

if ! docker exec "$container" psql -X -v ON_ERROR_STOP=1 -U "$postgres_user" -d postgres -Atc \
  'SELECT datname FROM pg_database' | grep -Fxq "$database"; then
  die "Source database '$database' does not exist or cannot be inspected."
fi

mkdir -p "$backup_dir"
chmod 700 "$backup_dir"
backup_dir="$(cd -P "$backup_dir" && pwd)"

timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
dump_file="$backup_dir/${database}-${timestamp}.dump"
temp_file="$dump_file.$$.tmp"

cleanup() {
  rm -f -- "$temp_file"
}
trap cleanup EXIT

printf 'Creating staging backup: container=%s database=%s file=%s\n' "$container" "$database" "$dump_file"
docker exec "$container" pg_dump -U "$postgres_user" --format=custom "$database" >"$temp_file"
[[ -s "$temp_file" ]] || die 'pg_dump completed without producing a backup archive.'
chmod 600 "$temp_file"
mv -f -- "$temp_file" "$dump_file"
shasum -a 256 "$dump_file" >"$dump_file.sha256"
chmod 600 "$dump_file.sha256"
trap - EXIT

printf 'Backup complete: %s (checksum: %s.sha256)\n' "$dump_file" "$dump_file"
