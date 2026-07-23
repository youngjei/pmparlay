#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

root="$(cd -P -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
env_file="${STAGING_ENV_FILE:-$root/.context/sepolia-staging.env}"
run_id="$$"
database="legwork_privy_e2e_${run_id}"
container="${STAGING_POSTGRES_CONTAINER:-legwork-postgres}"
postgres_user="${STAGING_POSTGRES_USER:-legwork}"
redis_container="legwork-privy-e2e-redis-${run_id}"
runtime_file="$root/.context/privy-e2e-runtime.json"
lock_directory="$root/.context/privy-e2e.lock"
declare -a pids=()

die() {
  printf 'privy-e2e-server: %s\n' "$*" >&2
  exit 1
}

cleanup() {
  local exit_code=$?
  trap - EXIT INT TERM
  for pid in "${pids[@]:-}"; do kill -TERM "$pid" 2>/dev/null || true; done
  for pid in "${pids[@]:-}"; do wait "$pid" 2>/dev/null || true; done
  docker exec "$container" dropdb -U "$postgres_user" --if-exists --force "$database" >/dev/null 2>&1 || exit_code=1
  docker rm -f "$redis_container" >/dev/null 2>&1 || true
  rm -f -- "$runtime_file"
  rmdir "$lock_directory" 2>/dev/null || true
  exit "$exit_code"
}
trap cleanup EXIT INT TERM

[[ "${PRIVY_E2E:-}" == '1' ]] || die 'Set PRIVY_E2E=1 to run the real Privy boundary test.'
[[ -f "$env_file" ]] || die "Missing staging environment: $env_file"
[[ "$(stat -f '%Lp' "$env_file")" == '600' ]] || die 'Staging environment must use mode 0600.'
command -v docker >/dev/null 2>&1 || die 'docker is required.'
docker inspect --type container "$container" >/dev/null 2>&1 || die "Postgres container not found: $container"
mkdir "$lock_directory" 2>/dev/null || die 'Another Privy E2E run is active or left a stale .context/privy-e2e.lock.'

node --env-file="$env_file" -e '
  if (process.env.NODE_ENV !== "production" || process.env.ACCOUNTING_MODE !== "house_book_usdc") process.exit(2);
' || die 'Privy E2E requires NODE_ENV=production and ACCOUNTING_MODE=house_book_usdc.'

database_url="$(DATABASE_NAME="$database" node --env-file="$env_file" -e '
  const value = process.env.DATABASE_URL;
  if (!value || !process.env.DATABASE_NAME) process.exit(2);
  const url = new URL(value);
  url.pathname = `/${process.env.DATABASE_NAME}`;
  process.stdout.write(url.toString());
')"
privy_app_id="$(node --env-file="$env_file" -e 'process.stdout.write(process.env.PRIVY_APP_ID || "")')"
[[ -n "$database_url" && -n "$privy_app_id" ]] || die 'Staging database URL and Privy app ID are required.'

redis_image="$(docker inspect --format '{{.Config.Image}}' legwork-redis)"
[[ -n "$redis_image" ]] || die 'Unable to identify the local Redis image.'
docker run --rm -d --name "$redis_container" -p 127.0.0.1::6379 "$redis_image" >/dev/null
redis_mapping="$(docker port "$redis_container" 6379/tcp)"
redis_port="${redis_mapping##*:}"
[[ "$redis_port" =~ ^[0-9]+$ ]] || die 'Unable to allocate an isolated Redis port.'
redis_url="redis://127.0.0.1:${redis_port}/0"
for _ in {1..40}; do
  docker exec "$redis_container" redis-cli PING 2>/dev/null | grep -q '^PONG$' && break
  sleep 0.1
done
docker exec "$redis_container" redis-cli PING 2>/dev/null | grep -q '^PONG$' || die 'Isolated Redis did not become ready.'

docker exec "$container" createdb -U "$postgres_user" "$database"
printf '{"database":"%s","postgresContainer":"%s","postgresUser":"%s","redisContainer":"%s"}\n' \
  "$database" "$container" "$postgres_user" "$redis_container" >"$runtime_file"
chmod 600 "$runtime_file"

cd "$root"
: >.context/privy-e2e-api.log
: >.context/privy-e2e-web.log
chmod 600 .context/privy-e2e-api.log .context/privy-e2e-web.log
env -i HOME="$HOME" PATH="$PATH" TMPDIR="${TMPDIR:-/tmp}" \
  DOTENV_CONFIG_PATH=/dev/null DOTENV_CONFIG_QUIET=true NODE_ENV=production ACCOUNTING_MODE=house_book_usdc \
  DATABASE_URL="$database_url" REDIS_URL="$redis_url" \
  node --env-file="$env_file" --import tsx server/db/migrate.ts

env -i HOME="$HOME" PATH="$PATH" TMPDIR="${TMPDIR:-/tmp}" \
  DOTENV_CONFIG_PATH=/dev/null DOTENV_CONFIG_QUIET=true NODE_ENV=production ACCOUNTING_MODE=house_book_usdc \
  DATABASE_URL="$database_url" REDIS_URL="$redis_url" API_HOST='127.0.0.1' API_PORT='8787' \
  WEB_ORIGIN='http://localhost:5175' \
  node --env-file="$env_file" --import tsx server/index.ts >.context/privy-e2e-api.log 2>&1 &
pids+=("$!")

env -i HOME="$HOME" PATH="$PATH" TMPDIR="${TMPDIR:-/tmp}" \
  VITE_ENABLE_PRIVY=true VITE_PRIVY_APP_ID="$privy_app_id" VITE_WALLETCONNECT_PROJECT_ID='' \
  node node_modules/vite/bin/vite.js --host 127.0.0.1 --port 5175 >.context/privy-e2e-web.log 2>&1 &
pids+=("$!")

while true; do
  for pid in "${pids[@]}"; do
    kill -0 "$pid" 2>/dev/null || die "child process exited; inspect .context/privy-e2e-*.log"
  done
  sleep 1
done
