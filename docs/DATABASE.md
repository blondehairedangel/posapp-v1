# Database configuration

Everything about reaching PostgreSQL. The application never hardcodes a host,
port, user, password or connection string — changing the target is
configuration only, never a code change.

## Configuration source of truth

All settings come from environment variables, resolved in one place:
[`src/lib/db-config.ts`](../src/lib/db-config.ts). The application *and* the
Prisma CLI both use it, so migrations and the running app can never disagree
about which database they mean.

### Precedence

| Order | Input | Behaviour |
| --- | --- | --- |
| 1 | `DATABASE_URL` | **Wins.** The `DB_*` variables are then ignored *entirely*. |
| 2 | `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD` | Composed into a URL. |
| 3 | neither | **Startup fails.** |

The two forms are never merged. A half-applied override — URL host with a
`DB_*` password — is impossible to reason about when a connection fails, so
one form wins outright.

There is **no localhost fallback**. An unconfigured app refuses to start,
because silently connecting to an unintended database (or creating a stray
local one) is worse than failing loudly.

### Variables

| Variable | Default | Notes |
| --- | --- | --- |
| `DATABASE_URL` | — | `postgresql://user:pass@host:5432/db?schema=public` |
| `DB_HOST` | — | hostname, service name, or IP |
| `DB_PORT` | `5432` | |
| `DB_NAME` | — | |
| `DB_USER` | — | |
| `DB_PASSWORD` | empty | may be empty for `trust`/`peer` auth |
| `DB_SCHEMA` | `public` | applied only if the URL omits `schema` |
| `DB_SSLMODE` | `disable` | `disable`/`allow`/`prefer`/`require`/`verify-ca`/`verify-full` |
| `DB_SSL_ROOT_CERT` | — | PEM CA bundle, required for `verify-*` |
| `DB_POOL_MAX` | `10` | **per process** |
| `DB_CONNECT_TIMEOUT_MS` | `10000` | |
| `DB_IDLE_TIMEOUT_MS` | `30000` | |

### Password escaping

In the `DB_*` form, credentials are percent-encoded for you — paste the
password as-is.

Inside `DATABASE_URL` you must encode it yourself:

| Character | Encode as |
| --- | --- |
| `@` | `%40` |
| `:` | `%3A` |
| `/` | `%2F` |
| `?` | `%3F` |
| `#` | `%23` |
| `%` | `%25` |

An unencoded `@` makes the URL parser read the wrong host, which surfaces as a
baffling "host not found" rather than a credential error. If the password is
awkward, prefer the `DB_*` form.

### Check what will be used

```bash
pnpm db:target
```

```
host=db.internal port=5432 database=sparepart_erp user=erp_app schema=public
  sslmode=verify-full pool=10 source=DATABASE_URL
url=postgresql://erp_app:***@db.internal:5432/sparepart_erp?sslmode=verify-full
local=false
```

The password is always redacted. Run this before any migration.

## Required database privileges

```sql
CREATE DATABASE sparepart_erp OWNER erp_app;
```

The user needs `CREATE TABLE` **and `CREATE SCHEMA`** — the job queue
(pg-boss) creates and owns a separate `pgboss` schema inside the same
database. Being the database owner is sufficient.

A user restricted to `public` will migrate successfully and then fail when the
*worker* starts, which is a confusing failure an hour later. Grant it up front.

## Scenario A — Local development

Without Docker, using the bundled dev server:

```bash
pnpm db:start                 # real PostgreSQL 17 on 127.0.0.1:5433
pnpm prisma:deploy
pnpm seed
pnpm dev
```

```bash
DATABASE_URL=postgresql://postgres@127.0.0.1:5433/sparepart_erp?schema=public
```

With a PostgreSQL container you started yourself:

```bash
docker run -d --name pg -p 5432:5432 \
  -e POSTGRES_PASSWORD=devpassword -e POSTGRES_DB=sparepart_erp \
  postgres:17-alpine
```

```bash
DATABASE_URL=postgresql://postgres:devpassword@localhost:5432/sparepart_erp?schema=public
```

## Scenario B — Separate Compose projects, same VPS

**Separate Compose projects do not share a network.** `postgres`, `db` and
`localhost` are *not* reachable from the app's containers by default. This is
the single most common cause of `getaddrinfo ENOTFOUND postgres`.

Find the database's network:

```bash
docker network ls
docker inspect <db-container> -f '{{json .NetworkSettings.Networks}}'
```

Attach the app to it — in `docker-compose.yml`:

```yaml
services:
  migrate:
    networks: [internal, dbnet]
  web:
    networks: [internal, web, dbnet]
  worker:
    networks: [internal, dbnet]

networks:
  dbnet:
    external: true
    name: dbstack_default        # the name from `docker network ls`
```

Then use the database's **service name** as the host:

```bash
DB_HOST=postgres        # or db, whatever the service is called
DB_PORT=5432
DB_NAME=sparepart_erp
DB_USER=erp_app
DB_PASSWORD=...
```

If you would rather not depend on the other project's generated network name,
create a shared one explicitly:

```bash
docker network create erp-shared
```

Attach it as `external: true` in *both* projects. This is more stable, because
`dbstack_default` changes if the directory is renamed.

Verify from inside the container before debugging further:

```bash
docker compose run --rm migrate sh -c 'getent hosts postgres || echo UNRESOLVED'
docker compose run --rm migrate pnpm db:target
```

**Do not publish 5432 to the host** to make this work. Container-to-container
traffic on a shared network needs no published port, and publishing widens the
attack surface for no benefit.

## Scenario C — PostgreSQL on a separate VPS

The app on VPS A, the database on VPS B. No code changes — only `DB_HOST`
(and TLS).

### Preferred: private networking

Use the provider's private network or a VPN (WireGuard, Tailscale) and bind
PostgreSQL to the private interface only.

```bash
DB_HOST=10.0.0.12          # private address, not the public one
DB_PORT=5432
DB_SSLMODE=require         # still encrypt inside the private network
```

### PostgreSQL server configuration (on VPS B)

`postgresql.conf` — listen on the private interface, never `*`:

```conf
listen_addresses = '10.0.0.12'     # NOT '*' and NOT '0.0.0.0'
port = 5432
ssl = on
ssl_cert_file = '/etc/postgresql/ssl/server.crt'
ssl_key_file  = '/etc/postgresql/ssl/server.key'
max_connections = 100
```

`pg_hba.conf` — authenticate with SCRAM, scoped to the app host's address.
Order matters; the first matching line wins:

```conf
# TYPE  DATABASE        USER      ADDRESS         METHOD
hostssl sparepart_erp   erp_app   10.0.0.11/32    scram-sha-256
```

- `hostssl`, not `host`: refuses non-TLS connections outright.
- `/32` — a single host. **Never `0.0.0.0/0`.**
- `scram-sha-256`, not `md5` or `trust`.

Reload:

```bash
sudo -u postgres psql -c 'SELECT pg_reload_conf();'
```

### Firewall (on VPS B)

Allow only the app server:

```bash
# ufw
sudo ufw allow from 10.0.0.11 to any port 5432 proto tcp
sudo ufw deny 5432

# nftables
nft add rule inet filter input ip saddr 10.0.0.11 tcp dport 5432 accept
nft add rule inet filter input tcp dport 5432 drop
```

Confirm it is not world-reachable from somewhere else entirely:

```bash
nmap -Pn -p 5432 <public-ip-of-vps-b>     # expect filtered/closed
```

### TLS on the client

If private networking is unavailable and traffic crosses the public internet,
`require` is **not** enough:

| Mode | Encrypts | Authenticates server | Use |
| --- | --- | --- | --- |
| `require` | yes | **no** | inside a trusted private network |
| `verify-ca` | yes | CA only | |
| `verify-full` | yes | CA + hostname | **public networks** |

`require` stops passive eavesdropping but not an active man-in-the-middle,
because the server's certificate is never checked. node-postgres defaults to
`rejectUnauthorized: false` for `require`; `verify-*` turns verification on.

```bash
DB_HOST=db.example.com
DB_SSLMODE=verify-full
DB_SSL_ROOT_CERT=/etc/ssl/certs/pg-ca.crt
```

Mount the CA into the containers (templates are in `docker-compose.yml`):

```yaml
volumes:
  - ./certs/pg-ca.crt:/etc/ssl/certs/pg-ca.crt:ro
```

The certificate's CN/SAN must match `DB_HOST` exactly, or `verify-full` fails
— that is the check doing its job.

### PostgreSQL on the Docker host

Not another VPS, but adjacent: the database runs natively on the same machine
as Docker.

```bash
DB_HOST=host.docker.internal
```

Docker Desktop resolves this already. On Linux, add to each service:

```yaml
extra_hosts:
  - 'host.docker.internal:host-gateway'
```

PostgreSQL must also be listening on the Docker bridge address and permit it
in `pg_hba.conf` (typically `172.17.0.0/16`).

## Connection pooling

`DB_POOL_MAX` is **per process**. The `web` and `worker` services each hold
their own pool, so size against the server's `max_connections`:

```
(DB_POOL_MAX x web replicas) + (DB_POOL_MAX / 2, worker) + headroom
  <  max_connections
```

The worker takes half the configured size, since it runs a bounded number of
concurrent jobs. With the defaults (10) and one replica of each, the app uses
at most ~15 connections.

Exceeding `max_connections` produces `too many clients already` under load —
not at deploy time — so leave headroom for `psql`, backups and monitoring.

If you need many web replicas, put **PgBouncer** in transaction pooling mode
in front and point `DB_HOST` at it. Keep `DB_POOL_MAX` small in that case
(2–5 per process); the pooler does the multiplexing.

One pool is created per process and cached on `globalThis`, so Next.js dev
hot-reload does not leak a new pool on every recompile.

## Migrations

Always confirm the target first:

```bash
pnpm db:target
```

| Command | Effect | Safe in production |
| --- | --- | --- |
| `pnpm prisma:deploy` | applies pending migrations, forward-only | **yes** |
| `pnpm prisma:migrate` | creates + applies a migration (dev) | no |
| `pnpm prisma:reset` | **DROPS ALL DATA**, re-applies, re-seeds | no |
| `pnpm db:wait` | blocks until the database answers | yes |

In Docker, the `migrate` service runs `prisma migrate deploy` once, waits for
the database first, and exits 0 before `web` and `worker` start — so two
replicas can never race to apply the same migration.

### Protection against migrating the wrong database

`pnpm prisma:reset` goes through [`scripts/db-guard.mts`](../scripts/db-guard.mts),
which refuses unless the host is loopback **and** `NODE_ENV` is not
`production`:

```
REFUSED: this would destroy data in "erp" on host "db.production.example.com".
  Reason: the host is not loopback, so this is not an obviously disposable database.
```

A stale `DATABASE_URL` exported in your shell is the usual way this accident
happens. Overriding it is deliberate and auditable:

```bash
DB_ALLOW_DESTRUCTIVE=i-understand-this-deletes-data pnpm prisma:reset
```

Nothing resets a database automatically. `migrate deploy` never drops or
rewrites; it only applies pending migrations.

## Credential handling

- Secrets live only in environment variables, never in source or in the image.
  The Docker build bakes **no** database configuration at all — not even a
  placeholder — so `docker history` cannot reveal one.
- Connection strings are never logged. `DATABASE_URL`, `DB_PASSWORD` and
  `connectionString` are in the logger's redaction list, and driver errors are
  passed through `sanitiseDbError()` before logging, because node-postgres
  includes the target in connection failures.
- Startup logs print `databaseTargetSummary()` — host, port, database, user,
  schema, sslmode — with no password.
- Nothing database-related is exposed to the browser. There is no
  `NEXT_PUBLIC_` database variable; `src/lib/db-config.ts` and `src/lib/db.ts`
  are server-only and importing them from a Client Component is a build error.

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| `No database configuration found` | neither `DATABASE_URL` nor the `DB_*` trio is set |
| `getaddrinfo ENOTFOUND postgres` | Scenario B without a shared network, or a wrong service name |
| `ECONNREFUSED 127.0.0.1:5432` | `localhost` inside a container means the *container* — use the service name or `host.docker.internal` |
| `no pg_hba.conf entry for host` | the app's IP is not permitted on the server |
| `password authentication failed` | wrong password, or an unencoded special character in `DATABASE_URL` |
| `self signed certificate in certificate chain` | `verify-*` without a correct `DB_SSL_ROOT_CERT` |
| `too many clients already` | `DB_POOL_MAX` x processes exceeds `max_connections` |
| worker exits `database unreachable` | it waited 120s and gave up; check `pnpm db:target` and the firewall |
| `CREATE SCHEMA` permission denied | the user cannot create the `pgboss` schema |
