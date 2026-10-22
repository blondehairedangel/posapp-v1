import { describe, expect, it } from 'vitest';
import { prisma } from '@/lib/db';
import {
  matchProduct,
  normalisePartNumber,
  searchProducts,
} from '@/server/services/matching';
import { createProduct, uid } from './helpers/fixtures';

/**
 * §17.2  Product matching by SKU and OEM number
 * §17.13 Ambiguous product matching and manual review
 */
describe('product matching', () => {
  it('normalises separators and case in a part number', () => {
    expect(normalisePartNumber('C-101')).toBe('C101');
    expect(normalisePartNumber('c 101')).toBe('C101');
    expect(normalisePartNumber('145520-2340')).toBe('1455202340');
  });

  it('matches an exact SKU with full confidence', async () => {
    const sku = uid('MATCHSKU');
    const product = await createProduct({ sku });

    const result = await matchProduct(`mau order ${sku} 10 pcs`);

    expect(result.autoMatch?.productId).toBe(product.id);
    expect(result.autoMatch?.method).toBe('EXACT_SKU');
    expect(result.needsReview).toBe(false);
  });

  it('matches an exact SKU written without separators', async () => {
    // A SKU with a long alpha prefix and no separators, as many real
    // catalogues print it.
    const sku = `FOSAKC${Date.now().toString().slice(-6)}`;
    const product = await createProduct({ sku });
    const result = await matchProduct(sku);
    expect(result.autoMatch?.productId).toBe(product.id);
  });

  it('matches on the OEM number', async () => {
    const oem = `90915-${Date.now().toString().slice(-6)}`;
    const product = await createProduct({ oemNumber: oem });

    const result = await matchProduct(`filter oli ${oem}`);

    expect(result.autoMatch?.productId).toBe(product.id);
    expect(result.autoMatch?.method).toBe('EXACT_OEM');
  });

  it('matches on a barcode', async () => {
    const barcode = `899${Date.now().toString().slice(-10)}`;
    const product = await createProduct({ barcode });
    const result = await matchProduct(barcode);
    expect(result.autoMatch?.productId).toBe(product.id);
    expect(result.autoMatch?.method).toBe('EXACT_BARCODE');
  });

  it('uses a declared cross reference but never an inferred one', async () => {
    const stocked = await createProduct({ name: 'Cross ref target part' });
    const externalNumber = `XREF-${Date.now().toString().slice(-7)}`;

    // Before the cross reference exists, the number must not resolve.
    const before = await matchProduct(externalNumber);
    expect(before.autoMatch).toBeNull();

    await prisma.productCrossReference.create({
      data: {
        productId: stocked.id,
        externalNumber,
        assertedBy: 'test',
      },
    });

    const after = await matchProduct(externalNumber);
    expect(after.candidates.map((c) => c.productId)).toContain(stocked.id);
    expect(
      after.candidates.find((c) => c.productId === stocked.id)?.method,
    ).toBe('CROSS_REFERENCE');
  });

  it('does NOT treat similar-looking part numbers as the same product', async () => {
    const stem = `ABC-${Date.now().toString().slice(-5)}`;
    const a = await createProduct({ sku: `${stem}1`, name: 'Part A' });
    await createProduct({ sku: `${stem}2`, name: 'Part B' });

    const result = await matchProduct(`${stem}1`);

    // The exact SKU wins; the near-identical number must not be auto-matched.
    expect(result.autoMatch?.productId).toBe(a.id);
    const other = result.candidates.find((c) => c.sku === `${stem}2`);
    expect(other?.score ?? 0).toBeLessThan(1);
  });

  it('flags an unmatched description for manual review', async () => {
    const result = await matchProduct('sesuatu yang tidak ada di katalog xyz');
    expect(result.autoMatch).toBeNull();
    expect(result.needsReview).toBe(true);
  });

  it('refuses to auto-match when two candidates score equally', async () => {
    // Two products sharing the same OEM number is legitimate (different
    // brands), and is exactly the case a human must disambiguate.
    const oem = `AMB-${Date.now().toString().slice(-6)}`;
    await createProduct({ oemNumber: oem, name: 'Ambiguous one' });
    await createProduct({ oemNumber: oem, name: 'Ambiguous two' });

    const result = await matchProduct(oem);

    expect(result.candidates.length).toBeGreaterThanOrEqual(2);
    expect(result.autoMatch).toBeNull();
    expect(result.needsReview).toBe(true);
  });

  it('never returns a product that is not in the catalogue', async () => {
    const result = await matchProduct('filter oli Sakura C-101');
    for (const candidate of result.candidates) {
      const exists = await prisma.product.findUnique({
        where: { id: candidate.productId },
        select: { id: true, sku: true },
      });
      expect(exists).not.toBeNull();
      expect(exists?.sku).toBe(candidate.sku);
    }
  });

  it('excludes inactive products from matching', async () => {
    const sku = uid('INACTIVE');
    const product = await createProduct({ sku });
    await prisma.product.update({
      where: { id: product.id },
      data: { status: 'INACTIVE' },
    });

    const result = await matchProduct(sku);
    expect(result.candidates.map((c) => c.productId)).not.toContain(product.id);
  });

  it('gives every candidate an explanation', async () => {
    const sku = uid('EXPLAIN');
    await createProduct({ sku, name: 'Explained part' });
    const result = await matchProduct(sku);
    for (const candidate of result.candidates) {
      expect(candidate.rationale.length).toBeGreaterThan(0);
    }
  });

  describe('catalogue search', () => {
    it('finds a product by partial SKU ignoring separators', async () => {
      const digits = Date.now().toString().slice(-6);
      const product = await createProduct({ sku: `SRCH-${digits}` });
      // Searching without the separator must still find it.
      const hits = await searchProducts(`srch${digits}`);
      expect(hits.map((h) => h.id)).toContain(product.id);
    });

    it('finds a product by vehicle compatibility', async () => {
      const product = await createProduct({ name: 'Vehicle searchable part' });
      await prisma.vehicleCompatibility.create({
        data: { productId: product.id, make: 'Mitsubishi', model: 'Pajero' },
      });

      const hits = await searchProducts('pajero');
      expect(hits.map((h) => h.id)).toContain(product.id);
    });

    it('returns nothing for an empty term rather than everything', async () => {
      expect(await searchProducts('   ')).toEqual([]);
    });
  });
});
