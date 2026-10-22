#!/usr/bin/env bash
# Ensures the local development PostgreSQL is up, then runs the given command.
#
#   scripts/with-db.sh pnpm prisma migrate dev
#   scripts/with-db.sh pnpm test
#
# Useful in sandboxed/CI shells where background processes do not survive
# between separate shell invocations.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
bash "$ROOT/scripts/dev-postgres.sh" start >/dev/null 2>&1 || {
  echo "failed to start development postgres" >&2
  bash "$ROOT/scripts/dev-postgres.sh" start
  exit 1
}
exec "$@"
