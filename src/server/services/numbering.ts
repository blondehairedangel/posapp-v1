import { prisma, type Db } from '@/lib/db';
import { Prisma, type DocumentKind } from '@/generated/prisma/client';

/**
 * Configurable document numbering.
 *
 * Patterns support {PREFIX}, {YYYY}, {YY}, {MM}, {DD} and {SEQ:n}.
 * Example: "{PREFIX}-{YYYY}{MM}-{SEQ:5}" -> "SO-202610-00042".
 *
 * Allocation uses a single atomic `UPDATE ... RETURNING` so two concurrent
 * requests can never be handed the same number. A SELECT-then-UPDATE would
 * collide under load and produce duplicate document numbers.
 */

export const DEFAULT_PREFIXES: Record<DocumentKind, string> = {
  QUOTATION: 'QT',
  SALES_ORDER: 'SO',
  DELIVERY_NOTE: 'DN',
  SALES_INVOICE: 'INV',
  SALES_RETURN: 'SR',
  CREDIT_NOTE: 'CN',
  PURCHASE_REQUEST: 'PR',
  PURCHASE_ORDER: 'PO',
  GOODS_RECEIPT: 'GR',
  SUPPLIER_INVOICE: 'SINV',
  PURCHASE_RETURN: 'PRT',
  STOCK_ADJUSTMENT: 'ADJ',
  STOCK_TRANSFER: 'TRF',
  STOCKTAKE: 'STK',
  TICKET: 'TKT',
  CUSTOMER: 'CUST',
  SUPPLIER: 'SUP',
  PAYMENT: 'PAY',
};

const DEFAULT_PATTERN = '{PREFIX}-{YYYY}{MM}-{SEQ:5}';

/** Month bucket, so counters restart each month. */
function periodKeyFor(date: Date, pattern: string): string {
  // A pattern without any date token must share one monotonic counter,
  // otherwise numbers would repeat when the period rolls over.
  if (!/\{(YYYY|YY|MM|DD)\}/.test(pattern)) return 'ALL';
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  if (!/\{MM\}/.test(pattern)) return String(y);
  return `${y}-${m}`;
}

function render(
  pattern: string,
  prefix: string,
  seq: number,
  date: Date,
): string {
  const y = date.getUTCFullYear();
  return pattern
    .replace(/\{PREFIX\}/g, prefix)
    .replace(/\{YYYY\}/g, String(y))
    .replace(/\{YY\}/g, String(y).slice(-2))
    .replace(/\{MM\}/g, String(date.getUTCMonth() + 1).padStart(2, '0'))
    .replace(/\{DD\}/g, String(date.getUTCDate()).padStart(2, '0'))
    .replace(/\{SEQ:(\d+)\}/g, (_m, width: string) =>
      String(seq).padStart(Number(width), '0'),
    )
    .replace(/\{SEQ\}/g, String(seq));
}

/**
 * Allocates the next number for `kind`.
 *
 * Pass the surrounding transaction as `db` when creating a document, so a
 * rolled-back document does not burn a number... and, more importantly, so the
 * number cannot be handed out twice.
 */
export async function nextNumber(
  kind: DocumentKind,
  db: Db = prisma,
  now: Date = new Date(),
): Promise<string> {
  const existing = await db.numberSequence.findFirst({
    where: { kind },
    select: { pattern: true, prefix: true },
  });

  const pattern = existing?.pattern ?? DEFAULT_PATTERN;
  const prefix = existing?.prefix ?? DEFAULT_PREFIXES[kind];
  const periodKey = periodKeyFor(now, pattern);

  // Insert-or-increment in one statement. ON CONFLICT handles the race where
  // two requests both find no row for a brand-new period.
  const rows = await db.$queryRaw<Array<{ nextValue: number }>>(Prisma.sql`
    INSERT INTO "number_sequences" ("id", "kind", "periodKey", "prefix", "pattern", "nextValue", "padding", "updatedAt")
    VALUES (gen_random_uuid()::text, ${kind}::"DocumentKind", ${periodKey}, ${prefix}, ${pattern}, 2, 5, now())
    ON CONFLICT ("kind", "periodKey")
    DO UPDATE SET "nextValue" = "number_sequences"."nextValue" + 1, "updatedAt" = now()
    RETURNING "nextValue"
  `);

  const returned = rows[0]?.nextValue ?? 2;
  // On insert we store 2 and the allocated value is 1; on update the stored
  // value is already incremented, so the allocated value is one less.
  const seq = returned - 1;

  return render(pattern, prefix, seq, now);
}

/** Preview without consuming a number — used by the settings screen. */
export function previewNumber(
  pattern: string,
  prefix: string,
  seq = 1,
  now: Date = new Date(),
): string {
  return render(pattern, prefix, seq, now);
}

export async function configureNumbering(
  kind: DocumentKind,
  input: { prefix?: string; pattern?: string },
  db: Db = prisma,
) {
  const pattern = input.pattern ?? DEFAULT_PATTERN;
  const prefix = input.prefix ?? DEFAULT_PREFIXES[kind];
  const periodKey = periodKeyFor(new Date(), pattern);
  await db.numberSequence.upsert({
    where: { kind_periodKey: { kind, periodKey } },
    create: { kind, periodKey, prefix, pattern, nextValue: 1 },
    update: { prefix, pattern },
  });
}
