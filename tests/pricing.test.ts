import { describe, expect, it } from 'vitest';
import { prisma } from '@/lib/db';
import { DiscountKind } from '@/generated/prisma/client';
import {
  computeDocumentTotals,
  computeLine,
  resolvePrice,
  applyAdjustment,
} from '@/server/services/pricing';
import { createPriceLevel, createProduct } from './helpers/fixtures';

/**
 * §17.5 Quotation calculation, and the pricing rules the pricelist generator
 * shares with the sales module.
 */
describe('pricing', () => {
  describe('line maths', () => {
    it('applies tax after the line discount', () => {
      // 10 x 100000 = 1,000,000; less 10% = 900,000; +11% tax = 999,000
      const line = computeLine({
        quantity: 10,
        unitPrice: '100000',
        discountPct: 10,
        taxRatePct: 11,
      });
      expect(line.lineSubtotal.toFixed(2)).toBe('900000.00');
      expect(line.lineDiscount.toFixed(2)).toBe('100000.00');
      expect(line.lineTax.toFixed(2)).toBe('99000.00');
      expect(line.lineTotal.toFixed(2)).toBe('999000.00');
    });

    it('keeps exact decimals where floats would drift', () => {
      // 3 x 0.10 must be exactly 0.30, not 0.30000000000000004
      const line = computeLine({ quantity: 3, unitPrice: '0.10' });
      expect(line.lineSubtotal.toFixed(2)).toBe('0.30');
    });

    it('handles a fractional quantity', () => {
      const line = computeLine({ quantity: '2.5', unitPrice: '95000' });
      expect(line.lineSubtotal.toFixed(2)).toBe('237500.00');
    });
  });

  describe('document totals', () => {
    it('sums lines, tax and shipping', () => {
      const totals = computeDocumentTotals({
        lines: [
          { quantity: 20, unitPrice: '27500', taxRatePct: 11 },
          { quantity: 10, unitPrice: '195000', taxRatePct: 11 },
        ],
        shippingFee: '50000',
      });

      // 550,000 + 1,950,000 = 2,500,000 subtotal
      expect(totals.subtotal.toFixed(2)).toBe('2500000.00');
      expect(totals.taxTotal.toFixed(2)).toBe('275000.00');
      expect(totals.grandTotal.toFixed(2)).toBe('2825000.00');
    });

    it('reduces tax proportionally for a document-level discount', () => {
      // A 10% document discount must also reduce the taxable base; charging
      // tax on a discount the customer never paid would overstate the invoice.
      const totals = computeDocumentTotals({
        lines: [{ quantity: 1, unitPrice: '1000000', taxRatePct: 11 }],
        discountKind: DiscountKind.PERCENT,
        discountValue: 10,
      });

      expect(totals.subtotal.toFixed(2)).toBe('1000000.00');
      expect(totals.discountTotal.toFixed(2)).toBe('100000.00');
      expect(totals.taxTotal.toFixed(2)).toBe('99000.00');
      expect(totals.grandTotal.toFixed(2)).toBe('999000.00');
    });

    it('never discounts below zero', () => {
      const totals = computeDocumentTotals({
        lines: [{ quantity: 1, unitPrice: '100' }],
        discountKind: DiscountKind.AMOUNT,
        discountValue: '500',
      });
      expect(totals.discountTotal.toFixed(2)).toBe('100.00');
      expect(totals.grandTotal.toFixed(2)).toBe('0.00');
    });

    it('returns zero totals for an empty document', () => {
      const totals = computeDocumentTotals({ lines: [] });
      expect(totals.grandTotal.toFixed(2)).toBe('0.00');
    });
  });

  describe('price level resolution', () => {
    it('uses the product list price when no level applies', async () => {
      const product = await createProduct({ sellingPrice: '27500' });
      const price = await resolvePrice(product.id);
      expect(price.unitPrice.toFixed(2)).toBe('27500.00');
      expect(price.source).toBe('list_price');
    });

    it("applies the level's default adjustment", async () => {
      const product = await createProduct({ sellingPrice: '100000' });
      const level = await createPriceLevel('-15');
      const price = await resolvePrice(product.id, { priceLevelId: level.id });
      expect(price.unitPrice.toFixed(2)).toBe('85000.00');
      expect(price.source).toBe('price_level_adjustment');
    });

    it('prefers an explicit override over the adjustment', async () => {
      const product = await createProduct({ sellingPrice: '100000' });
      const level = await createPriceLevel('-15');
      await prisma.productPrice.create({
        data: {
          productId: product.id,
          priceLevelId: level.id,
          price: '77777',
          minQuantity: '1',
        },
      });

      const price = await resolvePrice(product.id, { priceLevelId: level.id });
      expect(price.unitPrice.toFixed(2)).toBe('77777.00');
      expect(price.source).toBe('price_level_override');
    });

    it('selects the correct volume break', async () => {
      const product = await createProduct({ sellingPrice: '100000' });
      const level = await createPriceLevel('0');
      await prisma.productPrice.createMany({
        data: [
          { productId: product.id, priceLevelId: level.id, price: '95000', minQuantity: '1' },
          { productId: product.id, priceLevelId: level.id, price: '90000', minQuantity: '10' },
          { productId: product.id, priceLevelId: level.id, price: '85000', minQuantity: '50' },
        ],
      });

      const small = await resolvePrice(product.id, {
        priceLevelId: level.id,
        quantity: 5,
      });
      const medium = await resolvePrice(product.id, {
        priceLevelId: level.id,
        quantity: 10,
      });
      const large = await resolvePrice(product.id, {
        priceLevelId: level.id,
        quantity: 100,
      });

      expect(small.unitPrice.toFixed(0)).toBe('95000');
      expect(medium.unitPrice.toFixed(0)).toBe('90000');
      expect(large.unitPrice.toFixed(0)).toBe('85000');
    });

    it('never produces a negative price from a bad adjustment', async () => {
      const product = await createProduct({ sellingPrice: '10000' });
      const level = await createPriceLevel('-250');
      const price = await resolvePrice(product.id, { priceLevelId: level.id });
      expect(price.unitPrice.toFixed(2)).toBe('0.00');
    });
  });

  describe('pricelist adjustment', () => {
    it('applies a markup and a discount symmetrically', () => {
      expect(applyAdjustment('100000', 10).toFixed(0)).toBe('110000');
      expect(applyAdjustment('100000', -10).toFixed(0)).toBe('90000');
    });

    it('clamps a negative result to zero', () => {
      expect(applyAdjustment('100', -150).toFixed(0)).toBe('0');
    });
  });
});
