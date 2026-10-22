import { Prisma } from '@/generated/prisma/client';

/**
 * Decimal arithmetic helpers.
 *
 * Every monetary and quantity value in this application is a
 * Prisma.Decimal (PostgreSQL numeric). Float arithmetic is never used for
 * money: `0.1 + 0.2 !== 0.3` would turn into customer-visible invoice errors.
 */

export type Decimal = Prisma.Decimal;
export const Decimal = Prisma.Decimal;

export type DecimalInput = Prisma.Decimal | number | string | null | undefined;

/** Money is rounded to 2 dp at line/total boundaries. */
export const MONEY_DP = 2;
/** Quantities keep 3 dp (supports litres, kg, metres). */
export const QTY_DP = 3;

export function dec(value: DecimalInput): Decimal {
  if (value === null || value === undefined) return new Decimal(0);
  if (value instanceof Decimal) return value;
  return new Decimal(value);
}

/** Round half-up, the convention Indonesian invoicing expects. */
export function money(value: DecimalInput): Decimal {
  return dec(value).toDecimalPlaces(MONEY_DP, Decimal.ROUND_HALF_UP);
}

export function qty(value: DecimalInput): Decimal {
  return dec(value).toDecimalPlaces(QTY_DP, Decimal.ROUND_HALF_UP);
}

export function add(...values: DecimalInput[]): Decimal {
  return values.reduce<Decimal>((acc, v) => acc.plus(dec(v)), new Decimal(0));
}

export function sub(a: DecimalInput, b: DecimalInput): Decimal {
  return dec(a).minus(dec(b));
}

export function mul(a: DecimalInput, b: DecimalInput): Decimal {
  return dec(a).times(dec(b));
}

export function div(a: DecimalInput, b: DecimalInput): Decimal {
  const d = dec(b);
  if (d.isZero()) return new Decimal(0);
  return dec(a).dividedBy(d);
}

/** `pct` is a percentage, e.g. 11 for 11%. */
export function percentOf(value: DecimalInput, pct: DecimalInput): Decimal {
  return mul(dec(value), div(dec(pct), 100));
}

export function isZero(v: DecimalInput): boolean {
  return dec(v).isZero();
}

export function gt(a: DecimalInput, b: DecimalInput): boolean {
  return dec(a).greaterThan(dec(b));
}

export function gte(a: DecimalInput, b: DecimalInput): boolean {
  return dec(a).greaterThanOrEqualTo(dec(b));
}

export function lt(a: DecimalInput, b: DecimalInput): boolean {
  return dec(a).lessThan(dec(b));
}

export function lte(a: DecimalInput, b: DecimalInput): boolean {
  return dec(a).lessThanOrEqualTo(dec(b));
}

export function eq(a: DecimalInput, b: DecimalInput): boolean {
  return dec(a).equals(dec(b));
}

export function neg(v: DecimalInput): Decimal {
  return dec(v).negated();
}

export function max(a: DecimalInput, b: DecimalInput): Decimal {
  return gt(a, b) ? dec(a) : dec(b);
}

export function min(a: DecimalInput, b: DecimalInput): Decimal {
  return lt(a, b) ? dec(a) : dec(b);
}

/** Plain number — only for chart/metric display, never for arithmetic. */
export function toNumber(v: DecimalInput): number {
  return dec(v).toNumber();
}

export function toPlainString(v: DecimalInput): string {
  return dec(v).toFixed();
}

/**
 * Currency formatting. IDR is conventionally shown with no decimal places.
 */
export function formatCurrency(
  value: DecimalInput,
  currency = 'IDR',
  locale = 'id-ID',
): string {
  const fractionDigits = currency === 'IDR' ? 0 : 2;
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency,
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  }).format(toNumber(value));
}

/** Quantities drop trailing zeros: 2.000 -> "2", 2.500 -> "2.5". */
export function formatQuantity(
  value: DecimalInput,
  locale = 'id-ID',
): string {
  const d = qty(value);
  return new Intl.NumberFormat(locale, {
    minimumFractionDigits: 0,
    maximumFractionDigits: QTY_DP,
  }).format(d.toNumber());
}
