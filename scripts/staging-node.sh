#!/usr/bin/env bash
set -Eeuo pipefail

root="$(cd -P -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
source "$root/scripts/staging-env-files.sh"
configure_staging_env_files "$root"
[[ $# -ge 1 ]] || { printf 'Usage: %s <typescript-entrypoint> [args...]\n' "${0##*/}" >&2; exit 2; }

cd "$root"
exec env -i HOME="$HOME" PATH="$PATH" TMPDIR="${TMPDIR:-/tmp}" \
  DOTENV_CONFIG_PATH=/dev/null DOTENV_CONFIG_QUIET=true \
  node "${STAGING_ENV_FILE_ARGS[@]}" --import tsx "$@"
