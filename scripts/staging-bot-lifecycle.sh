#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

root="$(cd -P -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
source "$root/scripts/staging-env-files.sh"
configure_staging_env_files "$root"
auth_env="$root/.context/sepolia-lifecycle.env"

die() {
  printf 'staging-bot-lifecycle: %s\n' "$*" >&2
  exit 1
}

[[ -f "$auth_env" && ! -L "$auth_env" ]] || die 'missing .context/sepolia-lifecycle.env'
[[ "$(staging_file_mode "$auth_env")" == '600' ]] || die 'Sepolia lifecycle environment must use mode 0600'

while IFS= read -r line || [[ -n "$line" ]]; do
  [[ -z "$line" || "$line" == \#* ]] && continue
  key="${line%%=*}"
  case "$key" in
    QA_SEPOLIA_BOT_ACCESS_TOKEN|QA_SEPOLIA_BOT_IDENTITY_TOKEN|QA_SEPOLIA_OPS_API_KEY|QA_SEPOLIA_API_BASE_URL|QA_SEPOLIA_LIFECYCLE_CONFIRM|QA_SEPOLIA_LIFECYCLE_RUN_ID|QA_SEPOLIA_STAKE_USD|QA_SEPOLIA_OUTCOME_IDS|QA_SEPOLIA_MARKET_IDS|QA_SEPOLIA_OUTCOMES) ;;
    *) die "unsupported key in Sepolia lifecycle environment: $key" ;;
  esac
done <"$auth_env"

grep -qx 'QA_SEPOLIA_LIFECYCLE_CONFIRM=sepolia-positive-lifecycle' "$auth_env" || \
  die 'explicit fund-movement confirmation is missing'

cd "$root"
exec env -i HOME="$HOME" PATH="$PATH" TMPDIR="${TMPDIR:-/tmp}" \
  DOTENV_CONFIG_PATH=/dev/null DOTENV_CONFIG_QUIET=true \
  node "${STAGING_ENV_FILE_ARGS[@]}" --env-file="$auth_env" --import tsx server/qaSepoliaBotLifecycle.ts "$@"
