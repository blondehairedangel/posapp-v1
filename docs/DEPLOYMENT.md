# Deployment

## 1. Prerequisites

- Docker with Compose v2 (or Coolify, which wraps it)
- A domain with DNS pointing at the host, if you want HTTPS
- PostgreSQL 17 — provided by the `postgres` service unless you bring your own

## 2. Configure

```bash
cp .env.example .env
```

Generate the three secrets. Do not reuse values between environments:

```bash
openssl rand -base64 48   # SESSION_SECRET
openssl rand -base64 32   # APP_ENCRYPTION_KEY  (must decode to exactly 32 bytes)
openssl rand -hex 24      # POSTGRES_PASSWORD
```

Then set, at minimum:

| Variable | Notes |
| --- | --- |
| `APP_URL` | Public HTTPS origin. Used to build the WhatsApp callback URL and links in outbound email. |
| `DATABASE_URL` | **The only place the database and its password are set.** No compose file overrides it. See §2.1. |
| `POSTGRES_PASSWORD` | Only needed if you use the bundled database overlay. Must match the password inside `DATABASE_URL`. |
| `SESSION_SECRET` | Signs session cookies. Rotating it logs everyone out. |
| `APP_ENCRYPTION_KEY` | AES-256-GCM key for secrets stored in the database. **Rotating it makes every stored channel token and mailbox password undecryptable.** Back it up. |
| `APP_TIMEZONE` | Display timezone. Storage is always UTC. |

`APP_ENCRYPTION_KEY` must decode to exactly 32 bytes; the app refuses to boot
otherwise rather than failing later on first decrypt.

### 2.1 Pointing at your own PostgreSQL

> Full reference — precedence rules, all `DB_*` variables, separate-VPS setup
> with `pg_hba.conf`/firewall/TLS, pooling and migration safety — is in
> **[`docs/DATABASE.md`](DATABASE.md)**. The summary below covers the common
> cases.

Settings come from environment variables only; nothing is hardcoded. Either
supply a single `DATABASE_URL`, **or** the individual parts (`DB_HOST`,
`DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD`). `DATABASE_URL` wins when both
are present, and the `DB_*` values are then ignored entirely.

Confirm what will actually be used — the password is redacted:

```bash
pnpm db:target
```

`docker-compose.yml` contains **no database**. The application does not own
its PostgreSQL instance, and no compose file sets `DATABASE_URL` — it comes
from `.env` only, so there is nothing to silently override your value.

```
postgresql://USER:PASSWORD@HOST:PORT/DATABASE?schema=public
```

Choose `HOST` by where PostgreSQL actually runs:

| Your setup | `HOST` | Extra step |
| --- | --- | --- |
| PostgreSQL in **another compose stack** | its service name, e.g. `postgres` | share its network — below |
| PostgreSQL **on the Docker host** | `host.docker.internal` | on Linux add `extra_hosts: ['host.docker.internal:host-gateway']` to `migrate`, `web`, `worker` |
| **Managed/remote** (RDS, Neon, Supabase) | the provider hostname | usually `?sslmode=require` |
| The **bundled** overlay | `postgres` | see §3 |

To reach a database in another compose project, find its network and attach
to it:

```bash
docker network ls                       # e.g. my-postgres-stack_default
```

```yaml
# docker-compose.yml
networks:
  dbnet:
    external: true
    name: my-postgres-stack_default
```

Then add `dbnet` to the `networks:` list of `migrate`, `web` and `worker`.
A commented template is already in the file.

**Password encoding.** If the password contains `@ : / ? # %`, percent-encode
it (`@`→`%40`, `:`→`%3A`, `/`→`%2F`, `?`→`%3F`, `#`→`%23`, `%`→`%25`).
Otherwise the URL parser misreads where the host begins.

**Required privileges.** The user needs `CREATE TABLE` in the target database
**and `CREATE SCHEMA`** — the job queue (pg-boss) creates and owns a separate
`pgboss` schema there. Being the database owner is sufficient. A user
restricted to `public` will fail when the worker starts, not at migration
time, so grant it up front:

```sql
CREATE DATABASE sparepart_erp OWNER erp;
```

## 3. Start

Against your own PostgreSQL:

```bash
docker compose up -d --build
```

Or, if you do **not** already run PostgreSQL, overlay the bundled one:

```bash
docker compose -f docker-compose.yml -f docker-compose.postgres.yml \
  up -d --build
```

With the overlay, set both of these in `.env`, with matching passwords:

```bash
POSTGRES_PASSWORD=some-strong-password
DATABASE_URL=postgresql://erp:some-strong-password@postgres:5432/sparepart_erp?schema=public
```

Order is enforced by Compose: (`postgres` healthy, when used) → `migrate` runs
`prisma migrate deploy` and exits 0 → `web` and `worker` start. Running
migrations as a one-shot service means two web replicas can never race to
apply the same migration.

Create the first administrator:

```bash
docker compose exec web node_modules/.bin/tsx prisma/seed.mts
```

The seed is idempotent — it upserts reference data and only creates demo
transactions when the database has none, so re-running it will not inflate
stock or sales figures. Override the default credentials:

```bash
docker compose exec -e SEED_ADMIN_EMAIL=you@company.com \
                    -e SEED_ADMIN_PASSWORD='a-strong-password' \
                    web node_modules/.bin/tsx prisma/seed.mts
```

Change the seeded password immediately on a real deployment.

## 4. Verify

```bash
curl -fsS http://localhost:3000/api/health     # {"status":"ok","database":"up"}
docker compose ps                              # web + worker healthy, migrate exited 0
docker compose logs worker | tail              # "worker ready"
```

`/api/health` executes a real query, so a container that is listening but
cannot reach PostgreSQL reports 503 and the orchestrator will not route to it.

## 5. Coolify

1. **New Resource → Docker Compose**, point it at this repository.
2. Paste `.env` contents into Coolify's environment editor. Mark
   `SESSION_SECRET`, `APP_ENCRYPTION_KEY`, `POSTGRES_PASSWORD`,
   `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_APP_SECRET` and `SMTP_PASSWORD` as
   secrets so they are not shown in build logs.
3. Set the domain on the **web** service, port `3000`. Enable "Generate
   Let's Encrypt certificate".
4. Remove the `ports:` block from the `web` service so only Coolify's proxy
   reaches it. The proxy joins the `web` network.
5. Confirm the `postgres-data` and `attachments` volumes are listed as
   persistent before the first deploy.
6. Set the health-check path to `/api/health`.

### Reverse proxy requirements

The app trusts `X-Forwarded-For` only when `TRUST_PROXY=true`. Enable it
**only** behind a proxy that overwrites the header, otherwise a client can
spoof its IP and defeat the auth rate limiter. The proxy must also forward
`X-Forwarded-Proto: https` so cookies are issued with `Secure`.

## 6. Activating WhatsApp

The ERP runs fine with WhatsApp disabled. To enable it:

1. Meta **App Dashboard → WhatsApp → API Setup**: note the phone number ID
   and the WhatsApp Business Account ID; generate a permanent access token.
2. Copy the App Secret from **Settings → Basic**.
3. Choose any `WHATSAPP_VERIFY_TOKEN` string.
4. Set `WHATSAPP_ENABLED=true` plus the four values, and restart.
5. In **WhatsApp → Configuration**, set the callback URL to
   `https://your-domain/api/webhooks/whatsapp`, paste the same verify token,
   and subscribe to the `messages` field.

Meta's handshake will `GET` the callback and expects `hub.challenge` echoed
back. The webhook must be reachable over public HTTPS; a self-signed
certificate is rejected.

**Signature verification is mandatory in production.** With
`WHATSAPP_APP_SECRET` unset, `NODE_ENV=production` rejects every inbound
webhook — accepting unsigned payloads would let anyone inject messages into
the ticket system.

**Platform policy.** Free-form replies are only permitted inside the 24-hour
customer service window opened by a customer message. Outside it, WhatsApp
requires a pre-approved template. The client does not attempt to work around
this; a rejected send surfaces the provider error on the ticket and on the
delivery attempt record.

Verify on the **Integrations** page, which reports what is actually
configured and names any missing variables.

## 7. Activating email

Outbound (SMTP) is environment configuration: `SMTP_ENABLED=true`,
`SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_FROM_ADDRESS`.

Inbound (IMAP) is configured per department in the database, because each
department can own a mailbox. The worker polls every
`EMAIL_POLL_INTERVAL_SECONDS` (rounded up to a whole minute, since pg-boss
schedules are cron-based).

Progress is tracked as `(UIDVALIDITY, lastSeenUid)`. If the server renumbers
its UID space, the cursor is reset rather than trusted — trusting it would
silently skip mail — and duplicate tickets are still prevented downstream by
the RFC 5322 `Message-ID` uniqueness constraint.

## 8. Backup and recovery

Back up the database **and** `APP_ENCRYPTION_KEY`. A database restored
without the matching key leaves every stored channel token and mailbox
password undecryptable.

```bash
# Backup (compressed custom format)
docker compose exec -T postgres \
  pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc > backup-$(date +%F).dump

# Attachments (only when STORAGE_DRIVER=local)
docker run --rm -v sparepart-erp_attachments:/data -v "$PWD":/out alpine \
  tar czf /out/attachments-$(date +%F).tar.gz -C /data .
```

Restore:

```bash
docker compose stop web worker
docker compose exec -T postgres \
  pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --clean --if-exists < backup.dump
docker compose up -d web worker
```

Stop `web` and `worker` first: restoring under an active worker can interleave
job rows with restored data.

Verify a restore periodically against a scratch database. An untested backup
is not a backup.

### Retention

`StockMovement`, `AuditLog`, `ExternalMessage` and `ExtractionRun` are
append-only and grow without bound by design — they are the audit record.
Archive rather than delete: deleting a stock movement makes the corresponding
`InventoryBalance` unreconstructable.

## 9. Upgrades

```bash
git pull
docker compose up -d --build          # migrate re-runs automatically
```

Migrations are forward-only (`migrate deploy` never resets). Take a backup
before deploying a migration that drops or narrows a column.

## 10. Local development without Docker

The sandbox this was built in had no working container runtime, so there is a
Docker-free path:

```bash
pnpm install
pnpm db:start        # real PostgreSQL 17 from the Zonky binary distribution
pnpm prisma:migrate
pnpm seed
pnpm dev
```

`scripts/dev-postgres.sh` downloads genuine PostgreSQL binaries and runs them
as an unprivileged uid (PostgreSQL refuses to run as root). Use
`pnpm db:stop` to shut it down. This is for development and CI only — use the
`postgres` service, or a managed database, in production.
