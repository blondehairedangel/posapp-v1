import { describe, expect, it } from 'vitest';
import { prisma } from '@/lib/db';
import { ChannelType } from '@/generated/prisma/client';
import {
  claimWebhookEvent,
  ingestInboundMessage,
  matchEmailThread,
  matchWhatsAppThread,
  parseReferences,
  resolveByEmail,
  resolveByPhone,
} from '@/server/channels/ingest';
import {
  parseWebhookBody,
  toE164,
  verifyWebhookSignature,
} from '@/server/channels/whatsapp';
import { createContact, createCustomer, uid } from './helpers/fixtures';
import { createHmac } from 'node:crypto';
import { resetEnvCache } from '@/lib/env';

/**
 * §17.7 Duplicate webhook handling
 * §17.8 Email thread matching
 * §17.9 WhatsApp message-to-ticket mapping
 */
describe('inbound ingestion', () => {
  describe('phone normalisation', () => {
    it('normalises Indonesian local and international forms alike', () => {
      expect(toE164('08123456789')).toBe('+628123456789');
      expect(toE164('628123456789')).toBe('+628123456789');
      expect(toE164('+62 812-3456-789')).toBe('+628123456789');
      expect(toE164('8123456789')).toBe('+628123456789');
    });

    it('rejects obvious rubbish', () => {
      expect(toE164('')).toBeNull();
      expect(toE164('123')).toBeNull();
    });
  });

  describe('webhook idempotency', () => {
    it('claims an event once and rejects the replay', async () => {
      const eventId = `wamid.${uid('EV')}`;

      const first = await claimWebhookEvent({
        channelType: ChannelType.WHATSAPP,
        eventId,
        eventType: 'message',
      });
      const second = await claimWebhookEvent({
        channelType: ChannelType.WHATSAPP,
        eventId,
        eventType: 'message',
      });

      expect(first.fresh).toBe(true);
      expect(second.fresh).toBe(false);
    });

    it('keeps the same event id distinct per channel', async () => {
      const eventId = `shared-${uid('EV')}`;
      const wa = await claimWebhookEvent({
        channelType: ChannelType.WHATSAPP,
        eventId,
      });
      const email = await claimWebhookEvent({
        channelType: ChannelType.EMAIL,
        eventId,
      });

      expect(wa.fresh).toBe(true);
      expect(email.fresh).toBe(true);
    });

    it('does not create a second message for a duplicated provider id', async () => {
      const waId = `62811${Date.now().toString().slice(-7)}`;
      const externalId = `wamid.${uid('DUP')}`;

      const first = await ingestInboundMessage({
        channelType: ChannelType.WHATSAPP,
        externalId,
        fromAddress: waId,
        bodyText: 'Pesan pertama',
      });
      const second = await ingestInboundMessage({
        channelType: ChannelType.WHATSAPP,
        externalId,
        fromAddress: waId,
        bodyText: 'Pesan pertama',
      });

      expect('skipped' in first).toBe(false);
      expect('skipped' in second).toBe(true);

      if (!('skipped' in first)) {
        const count = await prisma.ticketMessage.count({
          where: { ticketId: first.ticketId },
        });
        expect(count).toBe(1);
      }
    });
  });

  describe('signature verification', () => {
    const body = '{"object":"whatsapp_business_account"}';

    it('accepts a correct X-Hub-Signature-256', () => {
      const secret = 'test-app-secret';
      process.env.WHATSAPP_APP_SECRET = secret;
      resetEnvCache();
      const digest = createHmac('sha256', secret).update(body).digest('hex');

      expect(verifyWebhookSignature(body, `sha256=${digest}`).ok).toBe(true);
      delete process.env.WHATSAPP_APP_SECRET;
      resetEnvCache();
    });

    it('rejects a tampered body', () => {
      const secret = 'test-app-secret';
      process.env.WHATSAPP_APP_SECRET = secret;
      resetEnvCache();
      const digest = createHmac('sha256', secret).update(body).digest('hex');

      expect(
        verifyWebhookSignature(`${body} tampered`, `sha256=${digest}`).ok,
      ).toBe(false);
      delete process.env.WHATSAPP_APP_SECRET;
      resetEnvCache();
    });

    it('rejects a missing signature header when a secret is set', () => {
      process.env.WHATSAPP_APP_SECRET = 'test-app-secret';
      resetEnvCache();
      expect(verifyWebhookSignature(body, null).ok).toBe(false);
      delete process.env.WHATSAPP_APP_SECRET;
      resetEnvCache();
    });
  });

  describe('webhook payload parsing', () => {
    it('extracts a text message and its ids', () => {
      const parsed = parseWebhookBody({
        object: 'whatsapp_business_account',
        entry: [
          {
            id: 'waba-1',
            changes: [
              {
                field: 'messages',
                value: {
                  metadata: { phone_number_id: '1234567890' },
                  contacts: [
                    { wa_id: '628123456789', profile: { name: 'Pak Hendra' } },
                  ],
                  messages: [
                    {
                      id: 'wamid.TEST1',
                      from: '628123456789',
                      timestamp: '1700000000',
                      type: 'text',
                      text: { body: 'Mau order filter oli 10 pcs' },
                    },
                  ],
                },
              },
            ],
          },
        ],
      });

      expect(parsed.events).toHaveLength(1);
      const event = parsed.events[0];
      expect(event?.kind).toBe('message');
      if (event?.kind === 'message') {
        expect(event.message.messageId).toBe('wamid.TEST1');
        expect(event.message.text).toBe('Mau order filter oli 10 pcs');
        expect(event.message.fromE164).toBe('+628123456789');
        expect(event.message.profileName).toBe('Pak Hendra');
      }
    });

    it('gives each status transition its own event id', () => {
      const build = (status: string) => ({
        entry: [
          {
            changes: [
              {
                value: {
                  metadata: { phone_number_id: '1' },
                  statuses: [
                    {
                      id: 'wamid.OUT1',
                      status,
                      recipient_id: '628123456789',
                      timestamp: '1700000000',
                    },
                  ],
                },
              },
            ],
          },
        ],
      });

      const sent = parseWebhookBody(build('sent')).events[0];
      const read = parseWebhookBody(build('read')).events[0];

      // Distinct ids, otherwise the 'read' update would be dropped as a
      // duplicate of 'sent'.
      expect(sent?.eventId).not.toBe(read?.eventId);
    });

    it('returns no events for an unrelated payload', () => {
      expect(parseWebhookBody({ object: 'page' }).events).toHaveLength(0);
      expect(parseWebhookBody(null).events).toHaveLength(0);
    });
  });

  describe('identity resolution', () => {
    it('resolves a verified contact email', async () => {
      const email = `${uid('mail').toLowerCase()}@buyer.example`;
      const customer = await createCustomer();
      await createContact(customer.id, { email, emailVerified: true });

      const identity = await resolveByEmail(email);
      expect(identity.customerId).toBe(customer.id);
      expect(identity.verified).toBe(true);
    });

    it('flags an unverified contact match as unverified', async () => {
      const email = `${uid('mail').toLowerCase()}@buyer.example`;
      const customer = await createCustomer();
      await createContact(customer.id, { email, emailVerified: false });

      const identity = await resolveByEmail(email);
      expect(identity.customerId).toBe(customer.id);
      expect(identity.verified).toBe(false);
    });

    it('does not resolve an unknown sender', async () => {
      const identity = await resolveByEmail('nobody@unknown.example');
      expect(identity.customerId).toBeNull();
    });

    it('matches a phone number across formats', async () => {
      const national = `62855${Date.now().toString().slice(-7)}`;
      const customer = await createCustomer();
      await createContact(customer.id, {
        whatsappE164: `+${national}`,
        whatsappVerified: true,
      });

      // The provider sends the wa_id without a '+'.
      const identity = await resolveByPhone(national);
      expect(identity.customerId).toBe(customer.id);
      expect(identity.verified).toBe(true);
    });

    it('never links two customers with similar names', async () => {
      await createCustomer({ name: 'Bengkel Maju Jaya' });
      await createCustomer({ name: 'Bengkel Maju Jaya Abadi' });

      // Name similarity is not an identity signal at all.
      const identity = await resolveByEmail('bengkel@unknown.example');
      expect(identity.customerId).toBeNull();
    });
  });

  describe('email threading', () => {
    it('parses a References header into message ids', () => {
      const refs = parseReferences('<a@x.com> <b@x.com>\n <c@x.com>');
      expect(refs).toEqual(['<a@x.com>', '<b@x.com>', '<c@x.com>']);
    });

    it('threads a reply onto the original ticket via In-Reply-To', async () => {
      const messageId = `<orig-${uid('m')}@buyer.example>`;
      const from = `${uid('mail').toLowerCase()}@buyer.example`;

      const first = await ingestInboundMessage({
        channelType: ChannelType.EMAIL,
        externalId: `imap-${uid('a')}`,
        fromAddress: from,
        subject: 'Permintaan penawaran',
        bodyText: 'Mohon dikirim penawaran.',
        messageIdHeader: messageId,
      });
      expect('skipped' in first).toBe(false);
      if ('skipped' in first) return;

      const second = await ingestInboundMessage({
        channelType: ChannelType.EMAIL,
        externalId: `imap-${uid('b')}`,
        fromAddress: from,
        subject: 'Re: Permintaan penawaran',
        bodyText: 'Menambahkan 2 item lagi.',
        messageIdHeader: `<reply-${uid('m')}@buyer.example>`,
        inReplyTo: messageId,
      });
      expect('skipped' in second).toBe(false);
      if ('skipped' in second) return;

      expect(second.ticketId).toBe(first.ticketId);
      expect(second.created).toBe(false);
      expect(second.threadVia).toBe('in-reply-to');
    });

    it('threads via the References chain when In-Reply-To is absent', async () => {
      const rootId = `<root-${uid('m')}@buyer.example>`;
      const from = `${uid('mail').toLowerCase()}@buyer.example`;

      const first = await ingestInboundMessage({
        channelType: ChannelType.EMAIL,
        externalId: `imap-${uid('c')}`,
        fromAddress: from,
        subject: 'Stok kampas rem',
        bodyText: 'Apakah ready?',
        messageIdHeader: rootId,
      });
      if ('skipped' in first) return;

      const match = await matchEmailThread({
        messageId: null,
        inReplyTo: null,
        references: `<unknown@x.com> ${rootId}`,
        subject: 'Re: Stok kampas rem',
      });

      expect(match.ticketId).toBe(first.ticketId);
      expect(match.via).toBe('references');
    });

    it('does NOT thread two unrelated emails from the same sender', async () => {
      const from = `${uid('mail').toLowerCase()}@buyer.example`;

      const first = await ingestInboundMessage({
        channelType: ChannelType.EMAIL,
        externalId: `imap-${uid('d')}`,
        fromAddress: from,
        subject: 'Enquiry about brake pads',
        bodyText: 'First enquiry',
        messageIdHeader: `<one-${uid('m')}@buyer.example>`,
      });
      const second = await ingestInboundMessage({
        channelType: ChannelType.EMAIL,
        externalId: `imap-${uid('e')}`,
        fromAddress: from,
        subject: 'Completely different topic',
        bodyText: 'Second, unrelated enquiry',
        messageIdHeader: `<two-${uid('m')}@buyer.example>`,
      });

      if ('skipped' in first || 'skipped' in second) throw new Error('unexpected skip');
      // Same person, different conversation: must be separate tickets.
      expect(second.ticketId).not.toBe(first.ticketId);
      expect(second.created).toBe(true);
    });

    it('threads on a ticket number found in the subject', async () => {
      const from = `${uid('mail').toLowerCase()}@buyer.example`;
      const first = await ingestInboundMessage({
        channelType: ChannelType.EMAIL,
        externalId: `imap-${uid('f')}`,
        fromAddress: from,
        subject: 'Order parts',
        bodyText: 'Please quote',
        messageIdHeader: `<subj-${uid('m')}@buyer.example>`,
      });
      if ('skipped' in first) return;

      const ticket = await prisma.ticket.findUnique({
        where: { id: first.ticketId },
        select: { number: true },
      });

      const match = await matchEmailThread({
        messageId: null,
        inReplyTo: null,
        references: null,
        subject: `Re: Order parts [${ticket?.number}]`,
      });

      expect(match.ticketId).toBe(first.ticketId);
      expect(match.via).toBe('subject-token');
    });
  });

  describe('whatsapp threading', () => {
    it('maps a reply onto the open ticket for that number', async () => {
      const waId = `62855${Date.now().toString().slice(-7)}`;

      const first = await ingestInboundMessage({
        channelType: ChannelType.WHATSAPP,
        externalId: `wamid.${uid('w1')}`,
        fromAddress: waId,
        bodyText: 'Mau order filter',
      });
      if ('skipped' in first) return;

      const second = await ingestInboundMessage({
        channelType: ChannelType.WHATSAPP,
        externalId: `wamid.${uid('w2')}`,
        fromAddress: waId,
        bodyText: 'Tambah 5 pcs lagi',
      });
      if ('skipped' in second) return;

      expect(second.ticketId).toBe(first.ticketId);
      expect(second.created).toBe(false);
    });

    it('starts a new ticket when the previous one is closed', async () => {
      const waId = `62856${Date.now().toString().slice(-7)}`;

      const first = await ingestInboundMessage({
        channelType: ChannelType.WHATSAPP,
        externalId: `wamid.${uid('w3')}`,
        fromAddress: waId,
        bodyText: 'Enquiry one',
      });
      if ('skipped' in first) return;

      await prisma.ticket.update({
        where: { id: first.ticketId },
        data: { status: 'CLOSED' },
      });

      const match = await matchWhatsAppThread({ waId });
      expect(match.ticketId).toBeNull();
    });

    it('threads on a quoted message id', async () => {
      const waId = `62857${Date.now().toString().slice(-7)}`;
      const originalId = `wamid.${uid('w4')}`;

      const first = await ingestInboundMessage({
        channelType: ChannelType.WHATSAPP,
        externalId: originalId,
        fromAddress: waId,
        bodyText: 'Original message',
      });
      if ('skipped' in first) return;

      const match = await matchWhatsAppThread({
        waId: 'a-different-number',
        contextMessageId: originalId,
      });
      expect(match.ticketId).toBe(first.ticketId);
      expect(match.via).toBe('quoted-message');
    });

    it('flags an unidentifiable sender for manual review', async () => {
      const result = await ingestInboundMessage({
        channelType: ChannelType.WHATSAPP,
        externalId: `wamid.${uid('w5')}`,
        fromAddress: `62899${Date.now().toString().slice(-7)}`,
        bodyText: 'Saya mau tanya harga',
      });
      if ('skipped' in result) throw new Error('unexpected skip');

      expect(result.needsManualReview).toBe(true);

      const external = await prisma.externalMessage.findUnique({
        where: { id: result.externalMessageId },
        select: { needsManualReview: true, customerId: true },
      });
      expect(external?.needsManualReview).toBe(true);
      // Critically: no customer was invented.
      expect(external?.customerId).toBeNull();
    });

    it('preserves the original message verbatim for audit', async () => {
      const body = 'Siang, mau order filter oli Sakura C-101 sebanyak 20 pcs';
      const result = await ingestInboundMessage({
        channelType: ChannelType.WHATSAPP,
        externalId: `wamid.${uid('w6')}`,
        fromAddress: `62877${Date.now().toString().slice(-7)}`,
        bodyText: body,
      });
      if ('skipped' in result) throw new Error('unexpected skip');

      const external = await prisma.externalMessage.findUnique({
        where: { id: result.externalMessageId },
        select: { bodyText: true },
      });
      expect(external?.bodyText).toBe(body);
    });
  });
});
