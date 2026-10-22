# Automotive Spare Parts ERP + Customer Order Ticketing

An ERP for an automotive spare parts distributor — inventory, sales,
purchasing and finance — combined with a WHMCS-style customer order desk that
turns WhatsApp and email enquiries into reviewable, traceable orders.

## What it does

A customer sends a WhatsApp message:

> "Siang, mau order filter oli Sakura C-101 sebanyak 20 pcs dan kampas rem
> depan Avanza 2018 sebanyak 10 set. Tolong cek harga dan stoknya."

The system stores the message verbatim, matches it to a customer by a
**verified** phone number, threads it onto the right ticket, and extracts two
order lines — 20 pcs and 10 set — resolving each against the real catalogue.
Prices and stock come from PostgreSQL, never from a language model. Anything
ambiguous is flagged with the reason, and a human must correct and approve it
before a quotation or sales order exists. Stock is reserved only when an order
is explicitly confirmed.

## Design rules

These are enforced in code and covered by tests, not just documented:

- **Nothing is invented.** The extractor may only report what the customer
  wrote. SKUs, prices and stock are read from the database; the output schema
  is `.strict()`, so a model cannot even return a SKU field.
- **A human gates every transaction.** An extracted draft is inert: it
  reserves nothing, sends nothing, and cannot be converted without an
  approval record.
- **Stock has one source of truth.** `StockMovement` is an append-only
  ledger; the balance table is a cache written in the same row-locked
  transaction and rebuildable from the ledger.
- **Internal notes never leak.** They are filtered in SQL, and the outbound
  dispatcher refuses to send one.
- **Identity is never guessed.** Customers are matched on verified email or
  E.164 phone only. Similar names are reported, never merged.
- **Threading is explicit.** Replies join a ticket via recorded `Message-ID`
  chains or WhatsApp message ids — not by sender address, which would merge
  unrelated enquiries.
- **Money is exact.** Every monetary and quantity column is PostgreSQL
  `numeric`; there are zero float columns.
- **Integrations never pretend.** An unconfigured channel says so and names
  the missing variables.

## Stack

Next.js 16 (App Router) · React 19 · TypeScript 5.9 · Tailwind 4 ·
PostgreSQL 17 · Prisma 7 · Zod 4 · pg-boss · Vitest

Full rationale, including why pg-boss over Redis and `scrypt` over argon2, is
in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Quick start

```bash
cp .env.example .env     # then fill in the secrets it names
pnpm install
pnpm db:start            # local PostgreSQL 17, no Docker required
pnpm prisma:migrate
pnpm seed
pnpm dev                 # http://localhost:3000
```

Sign in with the seeded account printed by `pnpm seed`
(`admin@sparepart.local` / `ChangeMe!2026`). Change it immediately outside
development.

The ERP is fully usable with WhatsApp, email and AI all switched off, which is
the default. Extraction falls back to a deterministic rule-based parser.

### Commands

| Command | Purpose |
| --- | --- |
| `pnpm dev` | Development server |
| `pnpm build` / `pnpm start` | Production build and serve |
| `pnpm worker` | Background worker (IMAP polling, dispatch, retries) |
| `pnpm test` | Resets the test database, then runs 170 tests |
| `pnpm typecheck` / `pnpm lint` | Static checks |
| `pnpm db:start` / `pnpm db:stop` | Local PostgreSQL without Docker |
| `pnpm seed` | Idempotent reference + demo data |

Tests run against a **real** PostgreSQL instance. Mocked database responses
would prove nothing about the transactional stock invariants they exist to
check.

## Deployment

```bash
docker compose up -d --build
```

See [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) for Coolify, HTTPS, WhatsApp
and email activation, backup/restore, and upgrades.

> The Dockerfile and Compose file have **not** been executed: the environment
> this was built in has no working container runtime. Everything else in
> `docs/IMPLEMENTATION_CHECKLIST.md` marked done was verified by a passing
> test, a successful build, or inspected command output.

## Layout

```
prisma/schema.prisma          86 models; conventions documented inline
src/app/(app)/                authenticated screens
src/app/api/webhooks/         signature-checked provider webhooks
src/server/services/          all business logic (money, stock, status)
src/server/extraction/        parser, LLM adapter, review pipeline
src/server/channels/          WhatsApp, email, ingestion, dispatch
src/server/actions/           Server Actions: authorise → validate → delegate
tests/                        170 integration tests
```

Server Actions and route handlers are thin by design: authenticate,
authorise, Zod-validate, then delegate to a service. Permission checks live in
the service boundary, never in the UI.

## Status

Working end to end: manual tickets, order extraction and review, quotations,
sales orders with stock reservation, invoicing and payments, dashboard, RBAC.

Not built yet: purchasing service/UI, pricelist generator, report screens,
and the sales/shipment screens (their services and tests exist). Live
WhatsApp and email delivery is implemented but unverified pending credentials.

[`docs/IMPLEMENTATION_CHECKLIST.md`](docs/IMPLEMENTATION_CHECKLIST.md) lists
every item with its evidence, plus what is blocked on external setup.
