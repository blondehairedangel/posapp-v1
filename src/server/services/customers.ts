import { prisma, type Db } from '@/lib/db';
import { nextNumber } from './numbering';
import { toE164 } from '@/server/channels/whatsapp';
import {
  CustomerType,
  DocumentKind,
  Prisma,
  type AddressKind,
} from '@/generated/prisma/client';

/**
 * Customer management.
 *
 * The governing rule (master prompt §4.B): records are NEVER merged, and a
 * customer is never auto-created, because two names look alike. Duplicate
 * detection therefore *reports* candidates with the reason they were flagged
 * and leaves the decision to a human. `createCustomer` will refuse a hard
 * conflict (an identical verified email or phone) but only warns on a name
 * similarity.
 */

export type DuplicateReason =
  | 'exact_email'
  | 'exact_phone'
  | 'exact_name'
  | 'similar_name'
  | 'exact_tax_id';

export interface DuplicateCandidate {
  customerId: string;
  code: string;
  name: string;
  reason: DuplicateReason;
  /** Hard conflicts should block creation; soft ones only warn. */
  severity: 'conflict' | 'warning';
  detail: string;
}

/** Collapses spacing, case and common company suffixes for comparison only. */
export function normaliseCompanyName(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\b(pt|cv|ud|pt\.|cv\.|ud\.|tbk|persero|ltd|llc|inc|co)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

/**
 * Finds potential duplicates.
 *
 * Deliberately returns candidates rather than acting: an "exact_email" hit is
 * a conflict worth blocking, but "Bengkel Maju Jaya" vs "Bengkel Maju Jaya
 * Abadi" are plausibly two real businesses and only a human can say.
 */
export async function findPotentialDuplicates(
  input: {
    name?: string | null;
    email?: string | null;
    phone?: string | null;
    taxId?: string | null;
    excludeCustomerId?: string | null;
  },
  db: Db = prisma,
): Promise<DuplicateCandidate[]> {
  const candidates: DuplicateCandidate[] = [];
  const seen = new Set<string>();

  const push = (c: DuplicateCandidate) => {
    const key = `${c.customerId}:${c.reason}`;
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push(c);
  };

  const exclude = input.excludeCustomerId
    ? { id: { not: input.excludeCustomerId } }
    : {};

  if (input.email?.trim()) {
    const email = input.email.trim().toLowerCase();
    const matches = await db.customer.findMany({
      where: {
        ...exclude,
        deletedAt: null,
        OR: [
          { primaryEmail: { equals: email, mode: 'insensitive' } },
          {
            contacts: {
              some: { email: { equals: email, mode: 'insensitive' } },
            },
          },
        ],
      },
      select: { id: true, code: true, name: true },
    });
    for (const m of matches) {
      push({
        customerId: m.id,
        code: m.code,
        name: m.name,
        reason: 'exact_email',
        severity: 'conflict',
        detail: `Already used by ${m.code} (${m.name})`,
      });
    }
  }

  if (input.phone?.trim()) {
    const e164 = toE164(input.phone) ?? input.phone.trim();
    const matches = await db.customer.findMany({
      where: {
        ...exclude,
        deletedAt: null,
        OR: [
          { primaryPhone: e164 },
          { contacts: { some: { phoneE164: e164 } } },
          { contacts: { some: { whatsappE164: e164 } } },
        ],
      },
      select: { id: true, code: true, name: true },
    });
    for (const m of matches) {
      push({
        customerId: m.id,
        code: m.code,
        name: m.name,
        reason: 'exact_phone',
        severity: 'conflict',
        detail: `Already used by ${m.code} (${m.name})`,
      });
    }
  }

  if (input.taxId?.trim()) {
    const matches = await db.customer.findMany({
      where: { ...exclude, deletedAt: null, taxId: input.taxId.trim() },
      select: { id: true, code: true, name: true },
    });
    for (const m of matches) {
      push({
        customerId: m.id,
        code: m.code,
        name: m.name,
        reason: 'exact_tax_id',
        severity: 'conflict',
        detail: `Tax ID already registered to ${m.code}`,
      });
    }
  }

  if (input.name?.trim()) {
    const normalised = normaliseCompanyName(input.name);
    const firstWord = normalised.split(' ')[0] ?? '';

    const matches =
      firstWord.length >= 3
        ? await db.customer.findMany({
            where: {
              ...exclude,
              deletedAt: null,
              name: { contains: firstWord, mode: 'insensitive' },
            },
            select: { id: true, code: true, name: true },
            take: 20,
          })
        : [];

    for (const m of matches) {
      const otherNormalised = normaliseCompanyName(m.name);
      if (otherNormalised === normalised) {
        push({
          customerId: m.id,
          code: m.code,
          name: m.name,
          reason: 'exact_name',
          // Still only a warning: two businesses can share a trading name.
          severity: 'warning',
          detail: `${m.code} has the same name — confirm they are different businesses`,
        });
      } else if (
        otherNormalised.startsWith(normalised) ||
        normalised.startsWith(otherNormalised)
      ) {
        push({
          customerId: m.id,
          code: m.code,
          name: m.name,
          reason: 'similar_name',
          severity: 'warning',
          detail: `Similar to ${m.code} (${m.name})`,
        });
      }
    }
  }

  return candidates;
}

export class DuplicateCustomerError extends Error {
  readonly conflicts: DuplicateCandidate[];
  constructor(conflicts: DuplicateCandidate[]) {
    super(
      `Cannot create customer: ${conflicts.map((c) => c.detail).join('; ')}`,
    );
    this.name = 'DuplicateCustomerError';
    this.conflicts = conflicts;
  }
}

export interface CreateCustomerInput {
  name: string;
  customerType?: CustomerType;
  code?: string | null;
  legalName?: string | null;
  taxId?: string | null;
  primaryEmail?: string | null;
  primaryPhone?: string | null;
  priceLevelId?: string | null;
  salespersonId?: string | null;
  paymentTermDays?: number;
  creditLimit?: string | number;
  notes?: string | null;
  /** Set by a human who has reviewed the flagged conflicts. */
  overrideDuplicates?: boolean;
  contacts?: Array<{
    name: string;
    position?: string | null;
    email?: string | null;
    phone?: string | null;
    isPrimary?: boolean;
  }>;
  addresses?: Array<{
    kind: AddressKind;
    line1: string;
    line2?: string | null;
    city?: string | null;
    province?: string | null;
    postalCode?: string | null;
    isDefault?: boolean;
  }>;
}

export async function createCustomer(input: CreateCustomerInput) {
  const duplicates = await findPotentialDuplicates({
    name: input.name,
    email: input.primaryEmail,
    phone: input.primaryPhone,
    taxId: input.taxId,
  });

  const conflicts = duplicates.filter((d) => d.severity === 'conflict');
  if (conflicts.length > 0 && !input.overrideDuplicates) {
    throw new DuplicateCustomerError(conflicts);
  }

  return prisma.$transaction(async (tx) => {
    const code = input.code?.trim() || (await nextNumber(DocumentKind.CUSTOMER, tx));

    const normalisedPhone = input.primaryPhone
      ? (toE164(input.primaryPhone) ?? input.primaryPhone)
      : null;

    return tx.customer.create({
      data: {
        code,
        name: input.name.trim(),
        legalName: input.legalName ?? null,
        customerType: input.customerType ?? CustomerType.BUSINESS,
        taxId: input.taxId ?? null,
        primaryEmail: input.primaryEmail?.trim().toLowerCase() ?? null,
        primaryPhone: normalisedPhone,
        priceLevelId: input.priceLevelId ?? null,
        salespersonId: input.salespersonId ?? null,
        paymentTermDays: input.paymentTermDays ?? 0,
        creditLimit: String(input.creditLimit ?? 0),
        notes: input.notes ?? null,
        contacts: input.contacts?.length
          ? {
              create: input.contacts.map((c, index) => ({
                name: c.name,
                position: c.position ?? null,
                email: c.email?.trim().toLowerCase() ?? null,
                phoneE164: c.phone ? (toE164(c.phone) ?? c.phone) : null,
                whatsappE164: c.phone ? (toE164(c.phone) ?? null) : null,
                isPrimary: c.isPrimary ?? index === 0,
                // Verification is a human act; never assumed at creation.
                emailVerified: false,
                whatsappVerified: false,
              })),
            }
          : undefined,
        addresses: input.addresses?.length
          ? {
              create: input.addresses.map((a) => ({
                kind: a.kind,
                line1: a.line1,
                line2: a.line2 ?? null,
                city: a.city ?? null,
                province: a.province ?? null,
                postalCode: a.postalCode ?? null,
                isDefault: a.isDefault ?? false,
              })),
            }
          : undefined,
      },
      include: { contacts: true, addresses: true },
    });
  });
}

/** Outstanding balance from unsettled invoices. */
export async function getCustomerBalance(customerId: string) {
  const rows = await prisma.$queryRaw<Array<{ outstanding: string }>>(
    Prisma.sql`
      SELECT COALESCE(SUM("grandTotal" - "paidTotal"), 0)::text AS outstanding
      FROM "sales_invoices"
      WHERE "customerId" = ${customerId}
        AND "status" IN ('ISSUED', 'PARTIALLY_PAID', 'OVERDUE')
    `,
  );
  return rows[0]?.outstanding ?? '0';
}
