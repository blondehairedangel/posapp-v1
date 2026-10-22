import { describe, expect, it } from 'vitest';
import {
  DuplicateCustomerError,
  createCustomer,
  findPotentialDuplicates,
  normaliseCompanyName,
} from '@/server/services/customers';
import { createContact, createCustomer as fixtureCustomer, uid } from './helpers/fixtures';

/** §17.1 Customer creation and duplicate detection */
describe('customers', () => {
  it('generates a customer code when none is supplied', async () => {
    const customer = await createCustomer({ name: `Bengkel ${uid()}` });
    expect(customer.code).toMatch(/^CUST-/);
  });

  it('normalises the phone number to E.164 on creation', async () => {
    const customer = await createCustomer({
      name: `Bengkel ${uid()}`,
      primaryPhone: '08123456700',
    });
    expect(customer.primaryPhone).toBe('+628123456700');
  });

  it('lower-cases the email on creation', async () => {
    const customer = await createCustomer({
      name: `Bengkel ${uid()}`,
      primaryEmail: 'MiXeD@Example.COM',
    });
    expect(customer.primaryEmail).toBe('mixed@example.com');
  });

  it('never marks a contact as verified at creation', async () => {
    const customer = await createCustomer({
      name: `Bengkel ${uid()}`,
      contacts: [{ name: 'Pak Budi', email: 'budi@example.com', phone: '08123456701' }],
    });
    expect(customer.contacts[0]?.emailVerified).toBe(false);
    expect(customer.contacts[0]?.whatsappVerified).toBe(false);
  });

  describe('company name normalisation', () => {
    it('ignores legal-form suffixes and punctuation', () => {
      expect(normaliseCompanyName('PT. Maju Jaya')).toBe('maju jaya');
      expect(normaliseCompanyName('CV Maju  Jaya')).toBe('maju jaya');
      expect(normaliseCompanyName('Maju Jaya')).toBe('maju jaya');
    });
  });

  describe('duplicate detection', () => {
    it('treats a repeated email as a blocking conflict', async () => {
      const email = `${uid('dup').toLowerCase()}@buyer.example`;
      await createCustomer({ name: `First ${uid()}`, primaryEmail: email });

      await expect(
        createCustomer({ name: `Second ${uid()}`, primaryEmail: email }),
      ).rejects.toThrow(DuplicateCustomerError);
    });

    it('detects an email already held by a contact, not just the customer', async () => {
      const email = `${uid('dup').toLowerCase()}@buyer.example`;
      const customer = await fixtureCustomer();
      await createContact(customer.id, { email });

      const found = await findPotentialDuplicates({ email });
      expect(found.map((f) => f.customerId)).toContain(customer.id);
      expect(found[0]?.severity).toBe('conflict');
    });

    it('treats a repeated phone number as a conflict across formats', async () => {
      const phone = `0812345${Date.now().toString().slice(-4)}`;
      await createCustomer({ name: `First ${uid()}`, primaryPhone: phone });

      // Same number written in international form must still conflict.
      const international = phone.replace(/^0/, '+62');
      await expect(
        createCustomer({ name: `Second ${uid()}`, primaryPhone: international }),
      ).rejects.toThrow(DuplicateCustomerError);
    });

    it('treats a repeated tax ID as a conflict', async () => {
      const taxId = `01.234.567.8-${Date.now().toString().slice(-3)}.000`;
      await createCustomer({ name: `First ${uid()}`, taxId });

      await expect(
        createCustomer({ name: `Second ${uid()}`, taxId }),
      ).rejects.toThrow(DuplicateCustomerError);
    });

    it('flags a similar name as a warning but still allows creation', async () => {
      const stem = `Bengkel Maju ${uid()}`;
      await createCustomer({ name: stem });

      // Two genuinely different businesses can share a name stem, so this
      // must NOT block — it is reported for a human to judge.
      const second = await createCustomer({ name: `${stem} Abadi` });
      expect(second.id).toBeTruthy();

      const found = await findPotentialDuplicates({ name: `${stem} Abadi` });
      const warnings = found.filter((f) => f.severity === 'warning');
      expect(warnings.length).toBeGreaterThan(0);
      expect(warnings.every((w) => w.severity === 'warning')).toBe(true);
    });

    it('reports an identical name as a warning, never as an automatic merge', async () => {
      const name = `Toko Onderdil ${uid()}`;
      const first = await createCustomer({ name });

      const found = await findPotentialDuplicates({ name });
      const exact = found.find((f) => f.reason === 'exact_name');

      expect(exact?.customerId).toBe(first.id);
      // Crucially a warning, not a conflict: the operator decides.
      expect(exact?.severity).toBe('warning');
    });

    it('allows creation past a conflict only with an explicit override', async () => {
      const email = `${uid('ovr').toLowerCase()}@buyer.example`;
      await createCustomer({ name: `First ${uid()}`, primaryEmail: email });

      const second = await createCustomer({
        name: `Second ${uid()}`,
        primaryEmail: email,
        overrideDuplicates: true,
      });
      expect(second.id).toBeTruthy();
    });

    it('excludes the record being edited from its own duplicate check', async () => {
      const email = `${uid('self').toLowerCase()}@buyer.example`;
      const customer = await createCustomer({
        name: `Self ${uid()}`,
        primaryEmail: email,
      });

      const found = await findPotentialDuplicates({
        email,
        excludeCustomerId: customer.id,
      });
      expect(found).toHaveLength(0);
    });

    it('returns nothing for a genuinely new customer', async () => {
      const found = await findPotentialDuplicates({
        name: `Completely Unique ${uid()}`,
        email: `${uid('new').toLowerCase()}@nowhere.example`,
      });
      expect(found).toHaveLength(0);
    });
  });
});
