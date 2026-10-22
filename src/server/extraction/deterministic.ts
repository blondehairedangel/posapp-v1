import { containsPartNumber } from '@/lib/part-number';
import {
  canonicaliseUnit,
  type ExtractedItem,
  type ExtractionOutput,
} from './schema';

/**
 * Deterministic order parser.
 *
 * This is the fallback that makes AI genuinely optional: with
 * AI_EXTRACTION_ENABLED=false the whole ordering workflow still functions,
 * using nothing but rules. It is also the safety net when the model errors,
 * times out, or returns a shape that fails schema validation.
 *
 * It is tuned for how Indonesian spare-parts customers actually write on
 * WhatsApp, e.g.
 *   "mau order filter oli Sakura C-101 sebanyak 20 pcs dan kampas rem depan
 *    Avanza 2018 sebanyak 10 set"
 */

/** Phrases that introduce an order but carry no item information. */
const LEAD_IN = [
  'selamat pagi', 'selamat siang', 'selamat sore', 'selamat malam',
  'pagi', 'siang', 'sore', 'malam', 'hallo', 'halo', 'hai', 'hi', 'hello',
  'permisi', 'maaf', 'mohon', 'tolong', 'bos', 'pak', 'bu', 'mas', 'mbak',
  'dear', 'good morning', 'good afternoon',
];

/** Phrases that end the item list and begin a general instruction. */
const TRAILING_REQUEST =
  /(tolong|mohon|please|minta)\s+(cek|check|kirim|info|konfirmasi|quote|penawaran|hitung)[\s\S]*$/i;

const ORDER_VERBS =
  /\b(mau|ingin|minta|pesan|order|beli|butuh|need|want|require|please\s+send)\b/gi;

const QTY_PREFIX = /\b(sebanyak|sejumlah|qty|quantity|jumlah|sebesar|x)\b/gi;

const UNIT_PATTERN =
  '(?:pcs|pc|pieces?|buah|biji|bh|ea|units?|sets?|pasang|pairs?|box(?:es)?|dus|karton|cartons?|lusin|dozen|liters?|litres?|ltr|l|kg|kilos?|kilograms?|meters?|metres?|m|rolls?|rol|packs?|pak|pck)';

/**
 * Splits a message into one segment per requested item.
 *
 * Splitting on " dan " / "," / newlines / bullets is what turns a single
 * run-on WhatsApp sentence into separate lines. A comma is only treated as a
 * separator when the following text looks like a new item (contains a digit or
 * is reasonably long), so "filter oli, merk Sakura" is not torn in two.
 */
export function splitSegments(text: string): string[] {
  const cleaned = text
    .replace(/\r/g, '')
    .replace(TRAILING_REQUEST, ' ')
    .trim();

  const byLine = cleaned
    .split(/\n+|(?:^|\s)[-*•·]\s+|\d+\s*[).]\s+/g)
    .flatMap((line) => line.split(/\s*(?:;|\bdan\b|\bserta\b|\bplus\b|&|\+)\s*/gi))
    .flatMap((part) => {
      // Only split a comma when both sides plausibly describe an item.
      const pieces = part.split(/,\s*/g);
      if (pieces.length === 1) return pieces;
      const out: string[] = [];
      let buffer = '';
      for (const piece of pieces) {
        const hasQty = /\d/.test(piece);
        if (buffer && !hasQty && piece.trim().split(/\s+/).length <= 2) {
          buffer = `${buffer}, ${piece}`;
        } else {
          if (buffer) out.push(buffer);
          buffer = piece;
        }
      }
      if (buffer) out.push(buffer);
      return out;
    });

  return byLine
    .map((s) => stripLeadIn(s))
    .map((s) => s.trim())
    .filter((s) => s.length > 2);
}

function stripLeadIn(segment: string): string {
  let s = segment.trim();
  let changed = true;
  while (changed) {
    changed = false;
    const lower = s.toLowerCase();
    for (const phrase of LEAD_IN) {
      if (lower.startsWith(`${phrase} `) || lower === phrase) {
        s = s.slice(phrase.length).replace(/^[\s,.:!-]+/, '');
        changed = true;
        break;
      }
    }
  }
  return s.replace(ORDER_VERBS, ' ').replace(/\s{2,}/g, ' ').trim();
}

interface QuantityHit {
  quantity: number;
  unit: string | null;
  /** Span of the matched text, removed from the description. */
  start: number;
  end: number;
}

/**
 * Finds the quantity in a segment.
 *
 * Preference order matters: a number attached to a unit ("10 set") wins over a
 * bare number, because a bare number in "kampas rem depan Avanza 2018" is a
 * model year, not a quantity. Four-digit years are explicitly rejected unless
 * they carry a unit.
 */
export function findQuantity(segment: string): QuantityHit | null {
  const withUnit = new RegExp(
    `(\\d+(?:[.,]\\d+)?)\\s*(${UNIT_PATTERN})\\b`,
    'i',
  );
  const m = withUnit.exec(segment);
  if (m && m[1]) {
    return {
      quantity: parseNumber(m[1]),
      unit: m[2] ?? null,
      start: m.index,
      end: m.index + m[0].length,
    };
  }

  // "sebanyak 20", "qty 20", "x 20"
  const prefixed = /\b(?:sebanyak|sejumlah|qty|quantity|jumlah|x)\s*[:=]?\s*(\d+(?:[.,]\d+)?)/i.exec(
    segment,
  );
  if (prefixed && prefixed[1]) {
    return {
      quantity: parseNumber(prefixed[1]),
      unit: null,
      start: prefixed.index,
      end: prefixed.index + prefixed[0].length,
    };
  }

  // A bare number, but never a model year and never part of a part number.
  const bare = /(?:^|\s)(\d{1,4}(?:[.,]\d+)?)(?=\s|$)/g;
  let hit: RegExpExecArray | null;
  while ((hit = bare.exec(segment)) !== null) {
    const raw = hit[1];
    if (!raw) continue;
    const value = parseNumber(raw);
    const isYear = /^\d{4}$/.test(raw) && value >= 1900 && value <= 2100;
    if (isYear) continue;
    // Skip a number glued to letters, e.g. the "101" inside "C-101".
    const before = segment.slice(Math.max(0, hit.index - 2), hit.index + 1);
    if (/[A-Za-z][-/]?$/.test(before.trimStart())) continue;
    return {
      quantity: value,
      unit: null,
      start: hit.index,
      end: hit.index + hit[0].length,
    };
  }

  return null;
}

function parseNumber(raw: string): number {
  // Indonesian decimal comma; "1.000" style thousands separators are rare in
  // chat quantities, so a lone dot is treated as a decimal point.
  return Number(raw.replace(',', '.'));
}

function cleanDescription(segment: string, hit: QuantityHit | null): string {
  const withoutQty = hit
    ? `${segment.slice(0, hit.start)} ${segment.slice(hit.end)}`
    : segment;
  return withoutQty
    .replace(QTY_PREFIX, ' ')
    .replace(/\s*[-–:]\s*$/, '')
    .replace(/^[\s,.:;-]+/, '')
    .replace(/[\s,.:;]+$/, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

const VEHICLE_YEAR = /\b(19\d{2}|20\d{2})\b/;

/**
 * Parses a free-text message into the same shape the LLM path produces, so the
 * rest of the pipeline is identical regardless of which engine ran.
 */
export function parseDeterministic(text: string): ExtractionOutput {
  const segments = splitSegments(text);
  const items: ExtractedItem[] = [];

  for (const segment of segments) {
    const hit = findQuantity(segment);
    const description = cleanDescription(segment, hit);

    // A segment with no describable content is noise, not an order line.
    if (description.length < 3) continue;
    // Require either a quantity or a part-number-shaped token; otherwise this
    // is conversational text ("harganya berapa ya").
    const looksLikeItem = hit !== null || containsPartNumber(description);
    if (!looksLikeItem) continue;

    const yearMatch = VEHICLE_YEAR.exec(description);

    items.push({
      original_text: segment,
      product_name: description,
      quantity: hit ? hit.quantity : null,
      unit: hit?.unit ? (canonicaliseUnit(hit.unit) ?? hit.unit) : null,
      vehicle_year: yearMatch?.[1] ? Number(yearMatch[1]) : null,
      notes: null,
    });
  }

  const trailing = TRAILING_REQUEST.exec(text.replace(/\r/g, ''));

  return {
    customer_reference: null,
    currency: null,
    items,
    customer_notes: trailing?.[0]?.trim() ?? null,
    requested_delivery_date: null,
  };
}
