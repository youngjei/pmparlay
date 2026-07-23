#!/usr/bin/env bash
set -Eeuo pipefail

root="$(cd -P -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
source "$root/scripts/staging-env-files.sh"
configure_staging_env_files "$root"
log_dir="$root/.context/staging-logs"
declare -a names=(api market deposit reconciliation settlement)
declare -a entries=(
  server/index.ts
  server/workers/marketIndexerWorker.ts
  server/workers/usdcDepositScannerWorker.ts
  server/workers/reconciliationWorker.ts
  server/workers/settlementResolverWorker.ts
)
declare -a pids=()

mkdir -p "$log_dir"
chmod 700 "$log_dir"

cleanup() {
  local status=$?
  trap - EXIT INT TERM
  for pid in "${pids[@]:-}"; do
    kill -TERM "$pid" 2>/dev/null || true
  done
  for pid in "${pids[@]:-}"; do
    wait "$pid" 2>/dev/null || true
  done
  exit "$status"
}
trap cleanup EXIT INT TERM

cd "$root"
for index in "${!names[@]}"; do
  name="${names[$index]}"
  env -i HOME="$HOME" PATH="$PATH" TMPDIR="${TMPDIR:-/tmp}" \
    DOTENV_CONFIG_PATH=/dev/null DOTENV_CONFIG_QUIET=true \
    node "${STAGING_ENV_FILE_ARGS[@]}" --import tsx "${entries[$index]}" >"$log_dir/$name.log" 2>&1 &
  pids+=("$!")
  printf '%s started pid=%s\n' "$name" "$!"
done

while true; do
  for index in "${!pids[@]}"; do
    if ! kill -0 "${pids[$index]}" 2>/dev/null; then
      wait "${pids[$index]}" || status=$?
      printf '%s exited unexpectedly; inspect %s/%s.log\n' "${names[$index]}" "$log_dir" "${names[$index]}" >&2
      exit "${status:-1}"
    fi
  done
  sleep 0.25
done
