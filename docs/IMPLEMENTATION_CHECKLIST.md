# Implementation checklist

Status as of the end of the first implementation session. **Done** means
implemented and verified by a passing test, a successful build, or a command
whose output was inspected. Nothing below is marked done on the strength of
code merely existing.

Verification commands: `pnpm lint`, `pnpm typecheck`, `pnpm test`,
`pnpm build`. Results are recorded in §Verification.

---

## Phase 1 — Audit and architecture ✅

- [x] Repository audit — workspace was **empty**; findings and sandbox
      constraints recorded in `docs/ARCHITECTURE.md` §1
- [x] Stack selected and pinned to stable releases (notably `prisma@7.10.1`,
      because `latest` is an `8.0.0-rc`)
- [x] Architecture, layering and invariants documented
- [x] This checklist

## Phase 2 — Foundation ✅

- [x] 86-table Prisma schema covering every entity in spec §12
- [x] Migrations applied against **real PostgreSQL 17.11** (not a mock)
- [x] All money/quantity columns `numeric` — verified **0 float columns** in
      the live schema
- [x] Session auth: `scrypt` hashing, DB-backed opaque tokens, `httpOnly`
      cookies, instant revocation
- [x] RBAC: 8 roles, 48 permissions, server-side `requirePermission` on every
      action
- [x] Audit log with field-level diffs, written in the same transaction as the
      change it records
- [x] Configurable document numbering with atomic `INSERT … ON CONFLICT …
      RETURNING` allocation
- [x] Validated environment loading (`src/lib/env.ts`), fails fast on boot
- [x] Design system, app shell, sidebar, responsive layout
- [x] Login, logout, forbidden page, rate-limited auth

## Phase 3 — Core ERP (partial)

- [x] **Customers** — service with duplicate detection (hard conflicts block,
      name similarity only warns); list screen with search
- [x] **Products** — catalogue, OEM numbers, barcodes, vehicle compatibility,
      explicit cross-references; list screen with unified search
- [x] **Inventory** — append-only `StockMovement` ledger, row-locked balance
      cache, reservations, moving-average cost, valuation, low-stock, ledger
      rebuild
- [x] **Pricing** — price levels, volume breaks, per-product overrides,
      document totals with proportional tax on document discounts
- [x] **Sales** — quotation → sales order → confirmation with stock
      reservation, backorders, cancellation with reservation release
- [x] **Invoicing** — invoice from order, payments with allocation across
      invoices, derived settlement status
- [ ] Sales UI (quotation/order/invoice screens) — services and tests exist;
      **no screens yet**
- [ ] Shipment picking/packing UI — `Shipment` model and
      `consumeReservation` exist; no workflow screens
- [ ] Purchasing — full schema (PR → PO → GR → supplier invoice → payment)
      and goods-receipt costing path exist; **no service layer or screens**
- [ ] Suppliers UI
- [ ] Warehouses / stock transfer / stocktake UI
- [ ] Pricelist generator — `exceljs` and `pdfkit` are installed and the
      pricing rules it must share are implemented and tested; **generator not
      written**

## Phase 4 — Ticketing ✅

- [x] Ticket inbox with 16 filters, search, sorting, pagination, counts
- [x] Three-panel desk (inbox | conversation | context), responsive
- [x] Manual ticket creation
- [x] Customer-visible replies vs internal notes, visually distinct
- [x] **Internal note privacy** — filtered in SQL, dispatch refuses to send
      one, regression-tested
- [x] Status workflow with administrator-configurable transitions
- [x] Assignment, departments, priority
- [x] SLA with configurable business hours; overdue detection
- [x] Ticket events, status history, full audit trail
- [x] Attachment storage + permission-checked streaming endpoint
- [ ] Ticket tags UI (`TicketTag` model and link table exist, unused)
- [ ] `@mention` notification UI (`TicketMention` written, not surfaced)
- [ ] Saved filters

## Phase 5 — Communication integrations (code complete, **not credential-verified**)

- [x] WhatsApp Cloud API client: text + template send, media parsing, status
      mapping
- [x] Webhook `GET` verification handshake
- [x] `X-Hub-Signature-256` verification over the **raw** body; rejects
      unsigned payloads in production
- [x] Idempotency via `UNIQUE(channelType, eventId)` — duplicate deliveries
      skipped, tested
- [x] Email: SMTP send with RFC 5322 threading headers; IMAP poller with
      `(UIDVALIDITY, lastSeenUid)` cursor
- [x] Email thread matching: `In-Reply-To` → `References` → ticket number in
      subject; **never** sender address alone
- [x] WhatsApp thread matching: quoted message id → open thread for `wa_id`
- [x] Inbound HTML sanitisation; attachment type/size/double-extension checks
- [x] Outbound delivery attempts recorded per attempt; unconfigured channels
      fail loudly instead of pretending to send
- [x] Persistent queue (pg-boss) with per-queue exponential backoff and a
      dead-letter queue — **verified running**: schema created, 5 queues and 2
      cron schedules registered, graceful SIGTERM shutdown
- [ ] **End-to-end send/receive against live WhatsApp and IMAP/SMTP** —
      blocked on credentials. See §Blocked.
- [ ] WhatsApp media download (message is ingested with a placeholder; the
      binary is not yet fetched from the media endpoint)
- [ ] Integrations screen is read-only — editing channel credentials from the
      UI is not implemented (environment variables only)

## Phase 6 — Order extraction ✅

- [x] Deterministic parser (works with **no AI provider**), tuned for
      Indonesian WhatsApp phrasing
- [x] Provider-independent LLM adapter (OpenAI / Anthropic /
      OpenAI-compatible), strict Zod validation, retry + timeout, usage
      logging, deterministic fallback, hard off switch
- [x] Prompt forbids the model from emitting SKUs/prices/stock; the schema is
      `.strict()` so it cannot
- [x] Product matching: exact SKU/OEM/barcode, supplier part number, declared
      cross-reference, name similarity — with an ambiguity guard
- [x] Ranked candidates retained with a human-readable rationale
- [x] Price and stock snapshots read from PostgreSQL, never from the model
- [x] Draft review UI: correct product/quantity, see why candidates were
      proposed, approve or reject
- [x] Corrections audited (`ExtractionCorrection`) for the correction-rate
      report
- [x] Approval gate: cannot approve with an unresolved line; cannot convert
      without approval
- [x] Duplicate conversion blocked by `UNIQUE(SalesOrder.orderDraftId)` plus
      an in-transaction status check

## Phase 7 — Reports, testing, deployment (partial)

- [x] **170 automated tests**, all passing, against real PostgreSQL
- [x] Docker multi-stage build, Compose with health checks, persistent
      volumes, separate migration service, non-root runtime
- [x] Deployment + Coolify + backup/restore documentation
- [x] `.env.example` with placeholders only; no secret committed
- [x] Production build succeeds
- [ ] **`docker build` / `docker compose up` not executed** — the sandbox has
      no working container runtime. See §Blocked.
- [ ] Reports UI — the underlying aggregates (`dashboard.ts`,
      `getInventoryValuation`, `getOutstandingByCustomer`) exist; no report
      screens or CSV/Excel export
- [ ] CSV/Excel export endpoints

---

## Test coverage against spec §17

| # | Requirement | Status |
| --- | --- | --- |
| 1 | Customer creation and duplicate detection | ✅ 14 tests |
| 2 | Product matching by SKU and OEM number | ✅ in 15 matching tests |
| 3 | Inventory availability calculations | ✅ in 17 inventory tests |
| 4 | Stock reservation and release | ✅ in 17 inventory tests |
| 5 | Quotation calculation | ✅ 14 pricing tests |
| 6 | Sales order creation | ✅ in 18 sales tests |
| 7 | Duplicate webhook handling | ✅ in 26 ingestion tests |
| 8 | Email thread matching | ✅ 5 threading tests |
| 9 | WhatsApp message-to-ticket mapping | ✅ 5 tests |
| 10 | Internal note privacy | ✅ 5 tests |
| 11 | Role-based access restrictions | ✅ 18 tests |
| 12 | Order extraction schema validation | ✅ in 16 extraction tests |
| 13 | Ambiguous matching and manual review | ✅ in matching tests |
| 14 | Prevention of duplicate order conversion | ✅ 6 tests |
| 15 | Invoice and payment calculations | ✅ 13 tests |

## Acceptance criteria (spec §19)

| | Criterion | Status |
| --- | --- | --- |
| A | Manual ticket: create, message, internal note, assign, status, audit | ✅ working and tested |
| B | Email: ingest → thread → reply → threading preserved | ⚠️ logic implemented and tested; **live send/receive unverified** (no mailbox) |
| C | WhatsApp: verified webhook → stored → reply → no duplicates | ✅ inbound path verified over real HTTP (see below); **outbound send to Meta unverified** (no credentials) |
| D | Order extraction → candidates → flagged → corrected → quotation | ✅ verified end to end (`pnpm smoke:workflow`) |
| E | Sales conversion with traceability and duplicate prevention | ✅ verified end to end (`pnpm smoke:workflow`) |
| F | Clean production build, reliable migrations, health checks, persistence | ⚠️ build, migrations and `/api/health` verified against a running server; **container start not verified** |

---

## Verification

### Static and automated checks

`pnpm verify` runs all four. Each was executed and its output inspected:

| Command | Result |
| --- | --- |
| `pnpm install` | exit 0, all build scripts run |
| `pnpm lint` | exit 0, no errors, no warnings |
| `pnpm typecheck` | exit 0, **0 errors** |
| `pnpm test` | exit 0, **170 passed / 170** across 10 files |
| `pnpm build` | exit 0, 14 routes compiled |

### Database

Inspected directly against PostgreSQL 17.11: **86 tables**, **30 enum types**,
**0 float columns**, and the corrected `UNIQUE(productId, warehouseId)` index
on `inventory_balances`.

### End-to-end workflow — `pnpm smoke:workflow`

Drives the real services against the real database and prints actual values.
Last run, all steps passed:

```
opening stock              on hand 120, reserved 0, available 120
inbound WhatsApp message   ticket created, customer matched on a VERIFIED number
duplicate delivery         skipped (idempotent), exactly 1 message on the ticket
extraction                 DRAFT-QT-202610-00002, 1 line, confidence 100%
                           price 25437.5 + stock 120 read FROM DATABASE
draft inertness            reserved unchanged — a draft reserves nothing
approval                   status=APPROVED
quotation                  QT-...-00003 subtotal 508750 tax 55962.5 total 564712.5
sales order                SO-...-00001, duplicate conversion PREVENTED
confirmation               reserved 20 -> on hand 120, reserved 20, available 100
invoice                    INV-...-00001 total 564712.5 status=ISSUED
payment                    part payment -> PARTIALLY_PAID; balance -> PAID
traceability               TKT-...-00002 → DRAFT-... → QT-... → SO-... → INV-...
```

The arithmetic is checkable: list price 27,500 less the workshop level's 7.5%
is 25,437.50; × 20 = 508,750; 11% PPN = 55,962.50; total 564,712.50.

### WhatsApp webhook over HTTP — `pnpm smoke:webhook`

Run against `next start` with a test app secret. All checks passed:

```
GET  handshake            200, hub.challenge echoed verbatim
GET  wrong verify token   403
POST tampered signature   401
POST missing signature    401
POST valid delivery       200, processed=1 -> ticket + message + extraction
POST duplicate delivery   200, duplicates=1, processed=0
database                  exactly 1 ticket, 1 message, 1 webhook-event row
```

This verifies signature checking and idempotency through the real route
handler. It does **not** verify sending to Meta, which needs credentials.

### Background worker

`pnpm worker` was started against the real database: pg-boss created its
schema (13 tables), registered all 5 queues (`message.dispatch`,
`extraction.run`, `email.poll`, `housekeeping`, `dead.letter`) and both cron
schedules, then shut down cleanly on SIGTERM.

## Blocked on external setup

1. **Container runtime.** The sandbox's `docker` is a podman shim with no
   working `conmon`, so `docker build` and `docker compose up` could not be
   executed. The Dockerfile and Compose file are authored carefully — and two
   real defects were found and fixed by inspection (the Prisma CLI being
   removed by `prune --prod`, and `import.meta.url` being empty in a CommonJS
   worker bundle) — but they remain **unverified**. Run
   `docker compose up -d --build` on a real engine before trusting them.
2. **WhatsApp credentials.** Needs a Meta app, a phone number ID, a permanent
   access token, an app secret and a public HTTPS callback. Until then the
   channel reports "not configured" and refuses to send.
3. **Email mailbox.** Needs IMAP and SMTP hosts plus credentials.
4. **AI provider (optional).** Not required: extraction falls back to the
   deterministic parser, which is what the tests exercise.

## Known gaps worth flagging

- `S3Driver` in `src/server/services/storage.ts` throws
  "not implemented" rather than silently losing files. `STORAGE_DRIVER=local`
  is the only working backend.
- The rate limiter is per-process, so N web replicas permit N × the limit.
  Adequate for slowing brute force; swap for a Redis/PostgreSQL counter if
  strict global limits are needed. Documented at the call site.
- `InventoryBalance` is keyed at `(product, warehouse)`, not per bin. Bin
  detail lives on `StockMovement.locationId`. This was deliberate: a nullable
  `locationId` in the unique key would let PostgreSQL create duplicate balance
  rows, because NULLs compare distinct.
- Goods receipt updates cost through `postMovement`, but there is no
  purchasing service or UI yet to drive it.
