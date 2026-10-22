import { z } from 'zod';

/**
 * Strict contract for extraction output.
 *
 * Every model response is validated against this before it is allowed near the
 * database. The schema is intentionally narrow: the model may only report what
 * the customer *wrote*. It cannot supply a SKU, a product id, a price or a
 * stock figure — those are resolved afterwards from PostgreSQL by the matching
 * and pricing services. A model that tries to invent a SKU produces an
 * unrecognised key, which `.strict()` rejects outright.
 */

export const UNIT_CANONICAL = [
  'pcs',
  'set',
  'unit',
  'box',
  'dus',
  'lusin',
  'pasang',
  'liter',
  'kg',
  'meter',
  'roll',
  'pack',
] as const;

export type CanonicalUnit = (typeof UNIT_CANONICAL)[number];

/** Maps the many spellings customers use onto a canonical unit. */
const UNIT_ALIASES: Record<string, CanonicalUnit> = {
  pc: 'pcs',
  pcs: 'pcs',
  piece: 'pcs',
  pieces: 'pcs',
  buah: 'pcs',
  biji: 'pcs',
  bh: 'pcs',
  ea: 'pcs',
  unit: 'unit',
  units: 'unit',
  set: 'set',
  sets: 'set',
  pasang: 'pasang',
  pair: 'pasang',
  pairs: 'pasang',
  box: 'box',
  boxes: 'box',
  dus: 'dus',
  karton: 'dus',
  carton: 'dus',
  lusin: 'lusin',
  dozen: 'lusin',
  liter: 'liter',
  litre: 'liter',
  ltr: 'liter',
  l: 'liter',
  kg: 'kg',
  kilo: 'kg',
  kilogram: 'kg',
  meter: 'meter',
  metre: 'meter',
  m: 'meter',
  roll: 'roll',
  rol: 'roll',
  pack: 'pack',
  pak: 'pack',
  pck: 'pack',
};

export function canonicaliseUnit(raw: string | null | undefined): CanonicalUnit | null {
  if (!raw) return null;
  const key = raw.toLowerCase().trim().replace(/\.$/, '');
  return UNIT_ALIASES[key] ?? null;
}

/* -------------------------------------------------------------------------- */
/*  Model output contract                                                     */
/* -------------------------------------------------------------------------- */

export const extractedItemSchema = z
  .object({
    /**
     * Verbatim span from the customer message. Required so a reviewer can
     * always see what the line was derived from.
     */
    original_text: z.string().min(1).max(500),
    /** Cleaned-up description. Still customer wording, not a catalogue name. */
    product_name: z.string().min(1).max(300),
    /** Null when the customer did not state a quantity. Never guessed. */
    quantity: z.number().positive().max(1_000_000).nullable(),
    unit: z.string().max(30).nullable(),
    /** Vehicle hints help the matcher; they are not authoritative. */
    vehicle_make: z.string().max(60).nullable().optional(),
    vehicle_model: z.string().max(60).nullable().optional(),
    vehicle_year: z.number().int().min(1900).max(2100).nullable().optional(),
    notes: z.string().max(500).nullable().optional(),
  })
  .strict();

export type ExtractedItem = z.infer<typeof extractedItemSchema>;

export const extractionOutputSchema = z
  .object({
    customer_reference: z.string().max(100).nullable(),
    currency: z.string().length(3).nullable().optional(),
    items: z.array(extractedItemSchema).max(100),
    customer_notes: z.string().max(2000).nullable(),
    requested_delivery_date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD')
      .nullable()
      .optional(),
  })
  .strict();

export type ExtractionOutput = z.infer<typeof extractionOutputSchema>;

/**
 * Shape handed to the review UI after matching, pricing and stock lookup.
 * `matched_product_id`, `sku`, `unit_price` and `available_qty` are populated
 * exclusively from the database.
 */
export interface ReviewableItem extends ExtractedItem {
  matched_product_id: string | null;
  sku: string | null;
  match_confidence: number;
  needs_review: boolean;
  candidates: Array<{
    productId: string;
    sku: string;
    name: string;
    score: number;
    rationale: string;
  }>;
}

export const EMPTY_EXTRACTION: ExtractionOutput = {
  customer_reference: null,
  currency: null,
  items: [],
  customer_notes: null,
  requested_delivery_date: null,
};
