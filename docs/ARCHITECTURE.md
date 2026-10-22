# Architecture — Automotive Spare Parts ERP + Order Ticketing

## 1. Repository audit (Phase 1 result)

The workspace `/projects/sandbox` was **empty** — no `package.json`, no lockfile, no
framework, no schema, no deployment config. There was therefore no existing
functionality to preserve and no documented reason to retain an alternative stack, so the
application was initialised from scratch on the prescribed stack (master prompt §2.4).

### Sandbox constraints discovered during the audit

These shaped two architecture decisions and are recorded so the choices are not re-litigated:

| Finding | Impact |
| --- | --- |
| `docker` is a podman shim with no working `conmon` binary — containers cannot run | Docker/Compose files are authored and lint-checked but **cannot be built or run here**. Verified `docker build` is deferred to a real engine. |
| `dnf` is unusable (`/var/log` read-only), no system PostgreSQL | Dev/test Postgres is provisioned from the Zonky binary distribution via `scripts/dev-postgres.sh` → **real PostgreSQL 17.11**, so migrations and integration tests run against a genuine server rather than a mock. |
| `/etc` read-only, cannot `useradd` | Postgres refuses to run as root, so the dev server runs as the pre-existing `nobody` uid via `setpriv`. |
| `npm` "latest" tags include prereleases (`prisma@8.0.0-rc`, `embedded-postgres@18-beta`) | Pinned to the newest **stable** releases instead: `prisma`/`@prisma/client` `7.10.1` (the `prev` dist-tag, i.e. latest GA). The `embedded-postgres` package was rejected outright — all 174 published versions are betas. |

## 2. Stack

| Concern | Choice | Notes |
| --- | --- | --- |
| Framework | Next.js 16.4.2 (App Router) + React 19.3.1 | Server Actions for mutations, Route Handlers for webhooks |
| Language | TypeScript 5.9.3 | `strict`; TS 7.0 skipped — too new for the ESLint/Prisma toolchain |
| Styling | Tailwind CSS 4.3.3 (CSS-first config) | |
| Components | shadcn/ui pattern on Radix primitives | Hand-authored into `src/components/ui` for version control |
| Database | PostgreSQL 17 | |
| ORM | Prisma 7.10.1 | `Decimal` for all money/quantities |
| Validation | Zod 4.6.7 | Shared between forms, actions, and the LLM output parser |
| Forms | React Hook Form 7.90 + `@hookform/resolvers` | |
| Auth | Custom DB-backed sessions, `scrypt` hashing | See §4 |
| Job queue | **pg-boss 12** (PostgreSQL-backed) | See §5 |
| Email | `imapflow` (inbound) + `nodemailer` (outbound) + `mailparser` | |
| WhatsApp | WhatsApp Business Platform Cloud API | Official Graph API only |
| Exports | `exceljs` (.xlsx) + `pdfkit` (.pdf) | |
| Logging | `pino` | Structured JSON |
| Tests | Vitest 5 | Business logic against real Postgres |

### Decisions worth justifying

**pg-boss over BullMQ/Redis.** The requirement is a *persistent* queue for webhook
processing, IMAP polling and retries. pg-boss stores jobs in the Postgres instance the app
already depends on, with transactional enqueue, exponential backoff, and dead-letter
queues. This removes Redis from the deployment surface — one less service to run, back up
and secure in Coolify — and lets a job be enqueued **in the same transaction** that
persists an inbound message, which is what makes webhook ingestion exactly-once rather
than best-effort.

**`scrypt` from `node:crypto` over argon2/bcrypt.** Both alternatives pull native
addons that must compile per-platform and inflate the Docker image. Node's built-in
`scrypt` is memory-hard, OWASP-sanctioned, has zero supply-chain surface, and needs no
build toolchain in the runtime image. Parameters (N=2^16, r=8, p=1) are stored alongside
each hash so they can be raised later without invalidating existing passwords.

**Custom sessions over NextAuth.** RBAC must be enforced server-side on every mutation
(§11), and permissions must be revocable immediately. Opaque DB-backed session tokens
allow instant revocation and per-request permission loading; a stateless JWT would keep
serving stale roles until expiry.

## 3. Layout

```
src/
  app/
    (auth)/login              # unauthenticated
    (app)/                    # authenticated shell: sidebar + topbar
      dashboard  tickets  customers  products  inventory
      sales  purchasing  suppliers  warehouses
      pricelist  reports  integrations  settings
    api/
      webhooks/whatsapp       # GET verify + POST receive (signature-checked)
      files/[id]              # permission-checked attachment streaming
  components/ui               # design system
  server/
    services/                 # ALL business logic lives here
    actions/                  # Server Actions: authz -> validate -> service
  lib/                        # db, auth, rbac, env, logger, money
tests/                        # Vitest
```

**The service layer is the only place that touches money, stock or status transitions.**
Server Actions and Route Handlers are thin: authenticate, authorise, Zod-validate, then
delegate. This keeps permission checks and invariants out of the UI layer, where they
could be bypassed, and makes the rules unit-testable without HTTP.

## 4. Authentication & authorisation

- Login → `scrypt` verify → opaque 256-bit session token, SHA-256 hashed at rest in
  `Session`, delivered as an `httpOnly` `SameSite=Lax` `Secure` cookie.
- Permissions are `resource:action` strings granted to roles; users hold roles.
- `requirePermission(perm)` runs inside every action/handler and throws before any write.
  Hiding a button is treated as cosmetic, never as access control.
- CSRF: mutations are Server Actions (same-origin enforced by Next.js) plus
  `SameSite=Lax` cookies. Public webhooks are exempt from sessions and instead
  authenticated by HMAC signature.

## 5. Inbound message pipeline

```
WhatsApp webhook / IMAP poll
  │  verify signature (WhatsApp) or TLS+UID tracking (IMAP)
  ├─ ProcessedWebhookEvent insert (unique eventId)  ← idempotency gate, dedupes retries
  ├─ ExternalMessage persisted verbatim             ← audit source of truth
  ├─ identify customer (verified email / E.164 phone), never fuzzy-name merge
  ├─ thread resolution: Message-ID/In-Reply-To/References, or WhatsApp conversation id
  │     └─ unresolved → manual review queue (configurable), never a wrong-thread append
  ├─ Ticket created or TicketMessage appended
  └─ enqueue extraction job (same transaction)
```

Extraction produces an **`OrderDraft` that is inert** — it reserves no stock, creates no
order, and sends nothing. A human must review it. Stock and prices on the draft are read
from Postgres through the pricing/inventory services; the LLM only segments text into
`{description, quantity, unit}` and is never trusted for a SKU, price or stock figure.

## 6. Inventory consistency

`InventoryBalance` is a derived cache; `StockMovement` is the append-only ledger of
record. Every mutation runs in a `prisma.$transaction` that writes the ledger row and
updates the balance under a row lock, so a balance can always be rebuilt from movements
and concurrent writers cannot interleave. Availability is
`onHand − reserved`, and reservations are explicit rows (`StockReservation`) tied to a
confirmed sales order — never to a ticket or a draft.

## 7. Money

All monetary and quantity columns are `Decimal` (`@db.Decimal(18,4)` for money, `(18,3)`
for quantities). No float arithmetic anywhere. Totals are recomputed server-side from
line items on every write; client-submitted totals are ignored.

## 8. Time

Stored in UTC (`timestamptz`), rendered in the configured `APP_TIMEZONE`
(default `Asia/Jakarta`). SLA clocks are computed against configurable business hours.
