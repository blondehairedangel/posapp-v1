#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Local development PostgreSQL, without Docker.
#
# Why this exists: the normal path for local development is the `postgres`
# service in docker-compose.yml. In sandboxes/CI images where no container
# runtime is available, this script provisions a REAL PostgreSQL server from
# the Zonky binary distribution (the same artifacts the embedded-postgres
# family of libraries uses) so migrations and integration tests run against
# genuine PostgreSQL rather than a stub.
#
# Usage: scripts/dev-postgres.sh {start|stop|status|restart|psql-uri|destroy}
# ---------------------------------------------------------------------------
set -euo pipefail

PG_VERSION="${PG_VERSION:-17.11.0}"
PG_PORT="${PG_PORT:-5433}"
PG_USER="${PG_USER:-postgres}"
PG_DB="${PG_DB:-sparepart_erp}"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEV="$ROOT/.devdata"
PGSQL="$DEV/pgsql"
PGDATA="$DEV/pgdata"
PGRUN="$DEV/pgrun"
LOG="$PGRUN/pg.log"

# PostgreSQL refuses to run as root. If we are root we drop to an unprivileged
# uid; `nobody` is used because sandboxes typically have a read-only /etc and
# cannot create a dedicated account.
RUN_UID="${PG_RUN_UID:-65534}"
RUN_GID="${PG_RUN_GID:-65534}"

as_pg() {
  if [ "$(id -u)" -eq 0 ]; then
    setpriv --reuid="$RUN_UID" --regid="$RUN_GID" --clear-groups \
      env HOME=/tmp TMPDIR=/tmp "$@"
  else
    env HOME="${HOME:-/tmp}" "$@"
  fi
}

fetch_binaries() {
  [ -x "$PGSQL/bin/postgres" ] && return 0
  echo "==> Downloading PostgreSQL $PG_VERSION binaries"
  mkdir -p "$DEV/jarx" "$PGSQL"
  local url="https://repo1.maven.org/maven2/io/zonky/test/postgres/embedded-postgres-binaries-linux-amd64/${PG_VERSION}/embedded-postgres-binaries-linux-amd64-${PG_VERSION}.jar"
  curl -fsSL "$url" -o "$DEV/pg.jar"
  ( cd "$DEV/jarx" && unzip -oq "$DEV/pg.jar" )
  tar -xJf "$DEV/jarx"/postgres-linux-*.txz -C "$PGSQL"
  echo "==> Extracted $("$PGSQL/bin/postgres" --version)"
}

init_cluster() {
  [ -f "$PGDATA/PG_VERSION" ] && return 0
  echo "==> Initialising cluster"
  mkdir -p "$PGDATA" "$PGRUN"
  if [ "$(id -u)" -eq 0 ]; then chown -R "$RUN_UID:$RUN_GID" "$DEV"; fi
  as_pg "$PGSQL/bin/initdb" -D "$PGDATA" -U "$PG_USER" \
    --auth=trust --encoding=UTF8 --locale=C >/dev/null
}

is_up() { as_pg "$PGSQL/bin/pg_ctl" -D "$PGDATA" status >/dev/null 2>&1; }

start() {
  fetch_binaries
  init_cluster
  if [ "$(id -u)" -eq 0 ]; then chown -R "$RUN_UID:$RUN_GID" "$DEV"; fi
  if is_up; then echo "==> Already running on port $PG_PORT"; else
    echo "==> Starting PostgreSQL on 127.0.0.1:$PG_PORT"
    as_pg "$PGSQL/bin/pg_ctl" -D "$PGDATA" -l "$LOG" -w -t 60 \
      -o "-p $PG_PORT -k $PGRUN -c listen_addresses=127.0.0.1" start
  fi
  create_db
  echo "==> DATABASE_URL=postgresql://$PG_USER@127.0.0.1:$PG_PORT/$PG_DB?schema=public"
}

# No psql ships with the Zonky distribution, so the bootstrap database is
# created through the node pg client that is already a dev dependency.
create_db() {
  node -e '
    const { Client } = require("pg");
    const [port, user, db] = process.argv.slice(1);
    (async () => {
      const c = new Client({ host: "127.0.0.1", port: +port, user, database: "postgres" });
      await c.connect();
      const r = await c.query("select 1 from pg_database where datname=$1", [db]);
      if (r.rowCount === 0) {
        await c.query(`create database "${db}"`);
        console.log(`==> Created database ${db}`);
      }
      await c.end();
    })().catch((e) => { console.error(e.message); process.exit(1); });
  ' "$PG_PORT" "$PG_USER" "$PG_DB"
}

case "${1:-start}" in
  start)   start ;;
  stop)    is_up && as_pg "$PGSQL/bin/pg_ctl" -D "$PGDATA" -w -m fast stop || echo "==> Not running" ;;
  restart) "$0" stop || true; "$0" start ;;
  status)  is_up && echo "==> running" || { echo "==> stopped"; exit 1; } ;;
  psql-uri) echo "postgresql://$PG_USER@127.0.0.1:$PG_PORT/$PG_DB?schema=public" ;;
  destroy) "$0" stop || true; rm -rf "$PGDATA"; echo "==> Cluster removed" ;;
  *) echo "usage: $0 {start|stop|restart|status|psql-uri|destroy}"; exit 2 ;;
esac
