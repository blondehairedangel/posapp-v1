import { prisma, type Db } from '@/lib/db';
import { env } from '@/lib/env';
import {
  extractPartNumberTokens,
  normalisePartNumber,
} from '@/lib/part-number';
import { MatchMethod, Prisma } from '@/generated/prisma/client';

export { extractPartNumberTokens, normalisePartNumber };

/**
 * Product matching for extracted order lines.
 *
 * Hard rule from the spec: two part numbers are NEVER treated as the same
 * product unless an explicit ProductCrossReference row says so. Nothing here
 * infers equivalence from numbers that merely look alike, and nothing here
 * invents a SKU — every candidate is a row that exists in the catalogue.
 *
 * Scores are deliberately coarse and rule-based rather than a learned
 * similarity: a distributor needs to be able to explain to a customer why a
 * part was substituted, so each candidate carries the rule that produced it.
 */

export interface MatchCandidate {
  productId: string;
  sku: string;
  name: string;
  brandName: string | null;
  oemNumber: string | null;
  score: number;
  method: MatchMethod;
  rationale: string;
}

export interface MatchResult {
  /** Non-empty only when a single candidate clears the auto-apply threshold. */
  autoMatch: MatchCandidate | null;
  candidates: MatchCandidate[];
  needsReview: boolean;
}

/** Confidence assigned per rule. Exact identifiers outrank name similarity. */
const SCORES = {
  EXACT_SKU: 1.0,
  EXACT_BARCODE: 1.0,
  EXACT_OEM: 0.95,
  SUPPLIER_PART: 0.9,
  CROSS_REFERENCE: 0.85,
  NAME_STRONG: 0.75,
  NAME_PARTIAL: 0.55,
  VEHICLE_HINT: 0.35,
} as const;

/* -------------------------------------------------------------------------- */
/*  Text normalisation                                                        */
/* -------------------------------------------------------------------------- */

export function normaliseText(input: string): string {
  return input
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Indonesian/English stop words that carry no matching signal. */
const STOP_WORDS = new Set([
  'untuk', 'buat', 'yang', 'dan', 'atau', 'dengan', 'pcs', 'pc', 'set', 'unit',
  'biji', 'buah', 'box', 'dus', 'lusin', 'pasang', 'the', 'for', 'and', 'with',
  'mau', 'order', 'pesan', 'minta', 'tolong', 'cek', 'harga', 'stok', 'stock',
  'ready', 'ada', 'berapa', 'bisa', 'kirim', 'beli',
]);

export function tokenise(input: string): string[] {
  return normaliseText(input)
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1 && !STOP_WORDS.has(t));
}

/* -------------------------------------------------------------------------- */
/*  Matching                                                                  */
/* -------------------------------------------------------------------------- */

interface ProductRow {
  id: string;
  sku: string;
  name: string;
  oemNumber: string | null;
  brandName: string | null;
}

function dedupeKeepBest(candidates: MatchCandidate[]): MatchCandidate[] {
  const best = new Map<string, MatchCandidate>();
  for (const c of candidates) {
    const existing = best.get(c.productId);
    if (!existing || c.score > existing.score) best.set(c.productId, c);
  }
  return [...best.values()].sort((a, b) => b.score - a.score);
}

/**
 * Resolves one free-text line to catalogue candidates.
 *
 * Returns `autoMatch` only when exactly one candidate clears the auto
 * threshold AND no other candidate is close enough to be plausible — an
 * ambiguous line must reach a human, which is the whole point of the review
 * step.
 */
export async function matchProduct(
  text: string,
  options: {
    autoThreshold?: number;
    suggestThreshold?: number;
    limit?: number;
  } = {},
  db: Db = prisma,
): Promise<MatchResult> {
  const autoThreshold =
    options.autoThreshold ?? env().EXTRACTION_AUTO_MATCH_THRESHOLD;
  const suggestThreshold =
    options.suggestThreshold ?? env().EXTRACTION_SUGGEST_THRESHOLD;
  const limit = options.limit ?? 8;

  const query = text.trim();
  if (!query) {
    return { autoMatch: null, candidates: [], needsReview: true };
  }

  const partTokens = extractPartNumberTokens(query);
  const normalisedParts = partTokens.map(normalisePartNumber);
  const words = tokenise(query);

  const candidates: MatchCandidate[] = [];

  /* --- 1. Exact identifier hits on SKU / OEM / barcode ------------------- */
  if (normalisedParts.length > 0) {
    const rows = await db.$queryRaw<
      Array<ProductRow & { matchedOn: string }>
    >(Prisma.sql`
      SELECT p."id", p."sku", p."name", p."oemNumber", b."name" AS "brandName",
             CASE
               WHEN regexp_replace(upper(p."sku"), '[^A-Z0-9]', '', 'g') = ANY(${normalisedParts}) THEN 'sku'
               WHEN regexp_replace(upper(COALESCE(p."barcode",'')), '[^A-Z0-9]', '', 'g') = ANY(${normalisedParts}) THEN 'barcode'
               ELSE 'oem'
             END AS "matchedOn"
      FROM "products" p
      LEFT JOIN "brands" b ON b."id" = p."brandId"
      WHERE p."deletedAt" IS NULL
        AND p."status" = 'ACTIVE'
        AND (
          regexp_replace(upper(p."sku"), '[^A-Z0-9]', '', 'g') = ANY(${normalisedParts})
          OR regexp_replace(upper(COALESCE(p."oemNumber", '')), '[^A-Z0-9]', '', 'g') = ANY(${normalisedParts})
          OR regexp_replace(upper(COALESCE(p."barcode", '')), '[^A-Z0-9]', '', 'g') = ANY(${normalisedParts})
        )
      LIMIT ${limit}
    `);

    for (const r of rows) {
      const method =
        r.matchedOn === 'sku'
          ? MatchMethod.EXACT_SKU
          : r.matchedOn === 'barcode'
            ? MatchMethod.EXACT_BARCODE
            : MatchMethod.EXACT_OEM;
      const score =
        r.matchedOn === 'sku'
          ? SCORES.EXACT_SKU
          : r.matchedOn === 'barcode'
            ? SCORES.EXACT_BARCODE
            : SCORES.EXACT_OEM;
      candidates.push({
        productId: r.id,
        sku: r.sku,
        name: r.name,
        brandName: r.brandName,
        oemNumber: r.oemNumber,
        score,
        method,
        rationale: `Exact ${r.matchedOn.toUpperCase()} match on "${partTokens.join(', ')}"`,
      });
    }

    /* --- 2. Supplier catalogue numbers --------------------------------- */
    const supplierRows = await db.$queryRaw<
      Array<ProductRow & { supplierName: string; supplierPartNo: string }>
    >(Prisma.sql`
      SELECT p."id", p."sku", p."name", p."oemNumber", b."name" AS "brandName",
             s."name" AS "supplierName", sp."supplierPartNo"
      FROM "supplier_products" sp
      JOIN "products" p  ON p."id" = sp."productId"
      JOIN "suppliers" s ON s."id" = sp."supplierId"
      LEFT JOIN "brands" b ON b."id" = p."brandId"
      WHERE p."deletedAt" IS NULL
        AND p."status" = 'ACTIVE'
        AND regexp_replace(upper(sp."supplierPartNo"), '[^A-Z0-9]', '', 'g') = ANY(${normalisedParts})
      LIMIT ${limit}
    `);

    for (const r of supplierRows) {
      candidates.push({
        productId: r.id,
        sku: r.sku,
        name: r.name,
        brandName: r.brandName,
        oemNumber: r.oemNumber,
        score: SCORES.SUPPLIER_PART,
        method: MatchMethod.SUPPLIER_PART_NUMBER,
        rationale: `Supplier part number ${r.supplierPartNo} (${r.supplierName})`,
      });
    }

    /* --- 3. Explicit, human-asserted cross references ------------------ */
    const crossRows = await db.$queryRaw<
      Array<ProductRow & { externalNumber: string | null }>
    >(Prisma.sql`
      SELECT p."id", p."sku", p."name", p."oemNumber", b."name" AS "brandName",
             x."externalNumber"
      FROM "product_cross_references" x
      JOIN "products" p ON p."id" = COALESCE(x."relatedProductId", x."productId")
      LEFT JOIN "brands" b ON b."id" = p."brandId"
      WHERE p."deletedAt" IS NULL
        AND p."status" = 'ACTIVE'
        AND regexp_replace(upper(COALESCE(x."externalNumber", '')), '[^A-Z0-9]', '', 'g') = ANY(${normalisedParts})
      LIMIT ${limit}
    `);

    for (const r of crossRows) {
      candidates.push({
        productId: r.id,
        sku: r.sku,
        name: r.name,
        brandName: r.brandName,
        oemNumber: r.oemNumber,
        score: SCORES.CROSS_REFERENCE,
        method: MatchMethod.CROSS_REFERENCE,
        rationale: `Declared cross-reference for ${r.externalNumber}`,
      });
    }
  }

  /* --- 4. Name / brand similarity --------------------------------------- */
  if (words.length > 0) {
    const pattern = `%${words.join('%')}%`;
    const anyWord = words.map((w) => `%${w}%`);

    const rows = await db.$queryRaw<Array<ProductRow & { hits: number }>>(
      Prisma.sql`
        SELECT p."id", p."sku", p."name", p."oemNumber", b."name" AS "brandName",
               (
                 SELECT COUNT(*)::int FROM unnest(${anyWord}::text[]) AS w
                 WHERE lower(p."name" || ' ' || COALESCE(b."name", '') || ' ' || COALESCE(p."description", '')) LIKE w
               ) AS hits
        FROM "products" p
        LEFT JOIN "brands" b ON b."id" = p."brandId"
        WHERE p."deletedAt" IS NULL
          AND p."status" = 'ACTIVE'
          AND (
            lower(p."name") LIKE ${pattern}
            OR EXISTS (
              SELECT 1 FROM unnest(${anyWord}::text[]) AS w
              WHERE lower(p."name" || ' ' || COALESCE(b."name", '')) LIKE w
            )
          )
        ORDER BY hits DESC, length(p."name") ASC
        LIMIT ${limit}
      `,
    );

    for (const r of rows) {
      // Require most of the query's words to appear before calling it strong.
      const ratio = words.length === 0 ? 0 : r.hits / words.length;
      const strong = ratio >= 0.8;
      candidates.push({
        productId: r.id,
        sku: r.sku,
        name: r.name,
        brandName: r.brandName,
        oemNumber: r.oemNumber,
        score: strong ? SCORES.NAME_STRONG : SCORES.NAME_PARTIAL * ratio,
        method: MatchMethod.FUZZY_NAME,
        rationale: `Name/brand similarity (${r.hits}/${words.length} terms)`,
      });
    }
  }

  const ranked = dedupeKeepBest(candidates).filter(
    (c) => c.score >= Math.min(suggestThreshold, autoThreshold),
  );
  const top = ranked[0];
  const runnerUp = ranked[1];

  // Ambiguity guard: an identical-scoring runner-up means a human must choose.
  const unambiguous =
    !!top &&
    top.score >= autoThreshold &&
    (!runnerUp || top.score - runnerUp.score >= 0.1);

  return {
    autoMatch: unambiguous ? top : null,
    candidates: ranked.slice(0, limit),
    needsReview: !unambiguous,
  };
}

/* -------------------------------------------------------------------------- */
/*  Catalogue search (UI)                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Product search for the UI selectors: SKU, OEM number, name, brand and
 * vehicle compatibility in one query.
 */
export async function searchProducts(
  term: string,
  options: { limit?: number; activeOnly?: boolean } = {},
  db: Db = prisma,
) {
  const limit = options.limit ?? 20;
  const q = term.trim();
  if (!q) return [];

  const like = `%${q.toLowerCase()}%`;
  const normalised = normalisePartNumber(q);

  return db.$queryRaw<
    Array<{
      id: string;
      sku: string;
      name: string;
      oemNumber: string | null;
      brandName: string | null;
      sellingPrice: string;
      onHand: string;
    }>
  >(Prisma.sql`
    SELECT p."id", p."sku", p."name", p."oemNumber",
           b."name" AS "brandName",
           p."sellingPrice"::text AS "sellingPrice",
           COALESCE((SELECT SUM(ib."onHand") FROM "inventory_balances" ib WHERE ib."productId" = p."id"), 0)::text AS "onHand"
    FROM "products" p
    LEFT JOIN "brands" b ON b."id" = p."brandId"
    WHERE p."deletedAt" IS NULL
      ${options.activeOnly === false ? Prisma.empty : Prisma.sql`AND p."status" = 'ACTIVE'`}
      AND (
        regexp_replace(upper(p."sku"), '[^A-Z0-9]', '', 'g') LIKE ${`%${normalised}%`}
        OR regexp_replace(upper(COALESCE(p."oemNumber", '')), '[^A-Z0-9]', '', 'g') LIKE ${`%${normalised}%`}
        OR lower(p."name") LIKE ${like}
        OR lower(COALESCE(b."name", '')) LIKE ${like}
        OR EXISTS (
          SELECT 1 FROM "vehicle_compatibilities" vc
          WHERE vc."productId" = p."id"
            AND (lower(vc."make") LIKE ${like} OR lower(COALESCE(vc."model", '')) LIKE ${like})
        )
      )
    ORDER BY
      CASE WHEN regexp_replace(upper(p."sku"), '[^A-Z0-9]', '', 'g') = ${normalised} THEN 0 ELSE 1 END,
      p."sku" ASC
    LIMIT ${limit}
  `);
}
