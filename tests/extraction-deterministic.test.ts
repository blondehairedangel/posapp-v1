import { describe, expect, it } from 'vitest';
import {
  findQuantity,
  parseDeterministic,
  splitSegments,
} from '@/server/extraction/deterministic';
import { extractionOutputSchema } from '@/server/extraction/schema';

/**
 * The deterministic parser is the fallback that makes AI optional, so it is
 * tested directly rather than through the pipeline.
 */
describe('deterministic order extraction', () => {
  // The exact message given in the specification (§8).
  const SPEC_MESSAGE =
    'Siang, mau order filter oli Sakura C-101 sebanyak 20 pcs dan kampas rem depan Avanza 2018 sebanyak 10 set. Tolong cek harga dan stoknya.';

  it('splits the spec message into exactly two item segments', () => {
    const segments = splitSegments(SPEC_MESSAGE);
    expect(segments).toHaveLength(2);
    expect(segments[0]).toContain('C-101');
    expect(segments[1]).toContain('Avanza');
  });

  it('extracts both items with the right quantities and units', () => {
    const result = parseDeterministic(SPEC_MESSAGE);

    expect(result.items).toHaveLength(2);

    const [first, second] = result.items;
    expect(first?.quantity).toBe(20);
    expect(first?.unit).toBe('pcs');
    expect(first?.product_name.toLowerCase()).toContain('filter oli');
    expect(first?.product_name).toContain('C-101');

    expect(second?.quantity).toBe(10);
    expect(second?.unit).toBe('set');
    expect(second?.product_name.toLowerCase()).toContain('kampas rem');
  });

  it('captures the trailing instruction as customer notes', () => {
    const result = parseDeterministic(SPEC_MESSAGE);
    expect(result.customer_notes).toMatch(/cek harga/i);
  });

  it('produces output that satisfies the strict schema', () => {
    const result = parseDeterministic(SPEC_MESSAGE);
    const parsed = extractionOutputSchema.safeParse(result);
    expect(parsed.success).toBe(true);
  });

  it('never invents a SKU or a product id', () => {
    const result = parseDeterministic(SPEC_MESSAGE);
    for (const item of result.items) {
      // The schema is `.strict()`, so these keys cannot be present at all.
      expect(item).not.toHaveProperty('sku');
      expect(item).not.toHaveProperty('matched_product_id');
      expect(item).not.toHaveProperty('unit_price');
    }
  });

  describe('quantity detection', () => {
    it('prefers a unit-qualified number over a model year', () => {
      const hit = findQuantity('kampas rem depan Avanza 2018 sebanyak 10 set');
      expect(hit?.quantity).toBe(10);
      expect(hit?.unit).toBe('set');
    });

    it('does not read a model year as a quantity', () => {
      const hit = findQuantity('kampas rem depan Avanza 2018');
      expect(hit).toBeNull();
    });

    it('does not read digits inside a part number as a quantity', () => {
      const hit = findQuantity('filter oli Sakura C-101');
      expect(hit).toBeNull();
    });

    it('handles a quantity written before the unit without a space', () => {
      expect(findQuantity('busi NGK 4pcs')?.quantity).toBe(4);
    });

    it('handles the "qty" prefix form', () => {
      const hit = findQuantity('oli mesin qty 5');
      expect(hit?.quantity).toBe(5);
    });

    it('reads a decimal quantity written with a comma', () => {
      expect(findQuantity('oli 2,5 liter')?.quantity).toBe(2.5);
    });
  });

  it('parses a multi-line bulleted order', () => {
    const message = [
      'Pagi pak, mohon dikirim:',
      '- Filter udara DENSO 145520-2340 10 pcs',
      '- Oli mesin Shell Helix 5W-30 4 liter',
      '2 set kampas rem belakang Innova',
    ].join('\n');

    const result = parseDeterministic(message);
    expect(result.items.length).toBeGreaterThanOrEqual(3);

    const denso = result.items.find((i) => i.original_text.includes('DENSO'));
    expect(denso?.quantity).toBe(10);
    expect(denso?.unit).toBe('pcs');

    const oli = result.items.find((i) => i.original_text.includes('Shell'));
    expect(oli?.quantity).toBe(4);
    expect(oli?.unit).toBe('liter');
  });

  it('canonicalises unit aliases', () => {
    expect(parseDeterministic('rem 3 buah').items[0]?.unit).toBe('pcs');
    expect(parseDeterministic('bearing 2 pasang').items[0]?.unit).toBe('pasang');
    expect(parseDeterministic('oli 1 dus').items[0]?.unit).toBe('dus');
  });

  it('returns no items for a purely conversational message', () => {
    const result = parseDeterministic(
      'Selamat pagi, saya mau tanya apakah toko buka hari ini?',
    );
    expect(result.items).toHaveLength(0);
  });

  it('records a missing quantity as null instead of guessing', () => {
    const result = parseDeterministic('mau order filter oli Sakura C-101');
    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.quantity).toBeNull();
  });

  it('keeps the original text verbatim for audit', () => {
    const result = parseDeterministic(SPEC_MESSAGE);
    for (const item of result.items) {
      expect(item.original_text.length).toBeGreaterThan(0);
      expect(SPEC_MESSAGE).toContain(
        item.original_text.slice(0, 15).replace(/^\s+/, ''),
      );
    }
  });
});
