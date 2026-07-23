#!/usr/bin/env bash
set -Eeuo pipefail

root="$(cd -P -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
source "$root/scripts/staging-env-files.sh"
configure_staging_env_files "$root"
base_env="$root/.context/sepolia-staging.env"

read_public_value() {
  node --env-file="$base_env" -e 'process.stdout.write(process.env[process.argv[1]] || "")' "$1"
}

privy_app_id="$(read_public_value PRIVY_APP_ID)"
settlement_chain_id="$(read_public_value SETTLEMENT_CHAIN_ID)"
usdc_contract_address="$(read_public_value USDC_CONTRACT_ADDRESS)"

[[ -n "$privy_app_id" ]] || { printf 'PRIVY_APP_ID missing from staging environment\n' >&2; exit 1; }
[[ "$settlement_chain_id" == '11155111' ]] || { printf 'Staging web launcher requires Sepolia\n' >&2; exit 1; }
[[ "$usdc_contract_address" == '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238' ]] || {
  printf 'Staging web launcher requires Circle Sepolia USDC\n' >&2
  exit 1
}

cd "$root"
exec env -i HOME="$HOME" PATH="$PATH" TMPDIR="${TMPDIR:-/tmp}" \
  VITE_ENABLE_PRIVY=true \
  VITE_PRIVY_APP_ID="$privy_app_id" \
  VITE_WALLETCONNECT_PROJECT_ID='' \
  VITE_SETTLEMENT_CHAIN_ID="$settlement_chain_id" \
  VITE_USDC_CONTRACT_ADDRESS="$usdc_contract_address" \
  VITE_API_PROXY_TARGET=http://127.0.0.1:8790 \
  npm run dev -- --host 127.0.0.1 --port 5174
