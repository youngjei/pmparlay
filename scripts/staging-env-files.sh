#!/usr/bin/env bash

staging_file_mode() {
  stat -c '%a' "$1" 2>/dev/null || stat -f '%Lp' "$1"
}

configure_staging_env_files() {
  local root="$1"
  local context="$root/.context"
  local base_env="$context/sepolia-staging.env"
  local settlement_env="$context/polygon-settlement.env"

  [[ -d "$context" && ! -L "$context" ]] || { printf 'Unsafe staging environment directory: %s\n' "$context" >&2; return 1; }
  [[ "$(cd -P -- "$context" && pwd)" == "$context" ]] || { printf 'Redirected staging environment directory: %s\n' "$context" >&2; return 1; }
  [[ -f "$base_env" && ! -L "$base_env" ]] || { printf 'Missing or unsafe staging environment: %s\n' "$base_env" >&2; return 1; }
  [[ "$(staging_file_mode "$base_env")" == '600' ]] || { printf 'Staging environment must use mode 0600: %s\n' "$base_env" >&2; return 1; }

  STAGING_ENV_FILE_ARGS=(--env-file="$base_env")
  if [[ -e "$settlement_env" || -L "$settlement_env" ]]; then
    [[ -f "$settlement_env" && ! -L "$settlement_env" ]] || { printf 'Unsafe Polygon settlement environment: %s\n' "$settlement_env" >&2; return 1; }
    [[ "$(staging_file_mode "$settlement_env")" == '600' ]] || { printf 'Polygon settlement environment must use mode 0600: %s\n' "$settlement_env" >&2; return 1; }
    while IFS= read -r line || [[ -n "$line" ]]; do
      [[ -z "$line" || "$line" == \#* ]] && continue
      local key="${line%%=*}"
      case "$key" in
        SETTLEMENT_AUTHORITY|SETTLEMENT_REQUIRE_ONCHAIN|SETTLEMENT_RPC_QUORUM|POLYGON_RPC_URL|POLYGON_RPC_OPERATOR|POLYGON_SECONDARY_RPC_URL|POLYGON_SECONDARY_RPC_OPERATOR|POLYGON_TERTIARY_RPC_URL|POLYGON_TERTIARY_RPC_OPERATOR) ;;
        *) printf 'Unsupported key in Polygon settlement environment: %s\n' "$key" >&2; return 1 ;;
      esac
    done <"$settlement_env"
    STAGING_ENV_FILE_ARGS+=(--env-file="$settlement_env")
  fi
}
