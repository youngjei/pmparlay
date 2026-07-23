#!/usr/bin/env bash
set -Eeuo pipefail

root="$(cd -P -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
database="legwork_sepolia_staging"
cd "$root"

bash scripts/staging-backup.sh
backup_file="$(find .context/backups -maxdepth 1 -type f -name "${database}-*.dump" -print0 | xargs -0 ls -1t | head -n 1)"
[[ -n "$backup_file" ]] || { echo "No verified reset backup was created" >&2; exit 1; }

STAGING_RESTORE_REHEARSAL_CONFIRM=RESTORE bash scripts/staging-restore-rehearsal.sh "$backup_file"
proof_file="$backup_file.restore-verified"
[[ -f "$proof_file" ]] || { echo "No restore attestation was created" >&2; exit 1; }

STAGING_RESET_CONFIRM="$database" STAGING_RESET_BACKUP_FILE="$backup_file" STAGING_RESET_RESTORE_PROOF="$proof_file" \
  exec node --import tsx server/provisionSepoliaStaging.ts --reset
