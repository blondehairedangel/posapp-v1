/**
 * Part-number recognition, shared by the extraction parser and the product
 * matcher so both agree on what counts as a part number.
 *
 * Nothing here decides that two different numbers are equivalent — that
 * requires an explicit ProductCrossReference row. These helpers only strip
 * formatting and spot number-shaped tokens in free text.
 */

/**
 * Strips separators and case so "C-101", "c 101" and "C101" compare equal.
 * This is a formatting normalisation of a single printed number, not a
 * similarity measure.
 */
export function normalisePartNumber(input: string): string {
  return input.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/**
 * A token is a contiguous alphanumeric run, optionally joined by the
 * separators that appear inside printed part numbers.
 *
 * A space is deliberately NOT a valid separator: allowing one would make
 * "Avanza 2018" look like a single part number, when it is a vehicle and a
 * model year. Real part numbers print their separators as -, /, . or _.
 */
const TOKEN = /[A-Za-z0-9]+(?:[-/._][A-Za-z0-9]+)*/g;

/** Pure digits up to 4 places are a quantity or a model year, not a part. */
const YEAR_OR_QUANTITY = /^\d{1,4}$/;

/** Minimum significant characters worth a catalogue lookup. */
const MIN_LENGTH = 4;

function isPartNumberShaped(token: string): boolean {
  const normalised = normalisePartNumber(token);
  if (normalised.length < MIN_LENGTH) return false;
  // Must contain at least one digit: catalogue numbers always do, and this is
  // what keeps ordinary words out.
  if (!/\d/.test(normalised)) return false;
  if (YEAR_OR_QUANTITY.test(normalised)) return false;
  return true;
}

/**
 * Extracts candidate part-number tokens, e.g.
 *   "filter oli Sakura C-101"      -> ["C-101"]
 *   "Filter udara DENSO 145520-2340" -> ["145520-2340"]
 *   "FOSAKC9911"                   -> ["FOSAKC9911"]
 *   "kampas rem depan Avanza 2018" -> []
 */
export function extractPartNumberTokens(input: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];

  for (const match of input.matchAll(TOKEN)) {
    const token = match[0];
    if (!isPartNumberShaped(token)) continue;
    const key = normalisePartNumber(token);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(token);
  }

  return out;
}

/** True when the text contains something that looks like a part number. */
export function containsPartNumber(input: string): boolean {
  return extractPartNumberTokens(input).length > 0;
}
