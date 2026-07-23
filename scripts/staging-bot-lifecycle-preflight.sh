#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

root="$(cd -P -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
source "$root/scripts/staging-env-files.sh"
configure_staging_env_files "$root"
auth_env="$root/.context/sepolia-preflight.env"

die() {
  printf 'staging-bot-lifecycle-preflight: %s\n' "$*" >&2
  exit 1
}

[[ -f "$auth_env" && ! -L "$auth_env" ]] || die 'missing .context/sepolia-preflight.env'
[[ "$(staging_file_mode "$auth_env")" == '600' ]] || die 'Sepolia preflight environment must use mode 0600'

while IFS= read -r line || [[ -n "$line" ]]; do
  [[ -z "$line" || "$line" == \#* ]] && continue
  key="${line%%=*}"
  case "$key" in
    QA_SEPOLIA_BOT_ACCESS_TOKEN|QA_SEPOLIA_EXPECTED_FINANCIAL_GATE_REASON|QA_SEPOLIA_API_BASE_URL) ;;
    *) die "unsupported key in Sepolia preflight environment: $key" ;;
  esac
done <"$auth_env"

cd "$root"
exec env -i HOME="$HOME" PATH="$PATH" TMPDIR="${TMPDIR:-/tmp}" \
  DOTENV_CONFIG_PATH=/dev/null DOTENV_CONFIG_QUIET=true \
  node "${STAGING_ENV_FILE_ARGS[@]}" --env-file="$auth_env" --import tsx server/qaSepoliaBotLifecyclePreflight.ts
