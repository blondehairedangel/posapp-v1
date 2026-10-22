/**
 * Verifies the WhatsApp webhook over real HTTP against a running server.
 *
 * Covers the parts of spec §19 C that do not need Meta credentials:
 *   - GET subscription handshake echoes hub.challenge
 *   - a wrong verify token is rejected
 *   - a valid X-Hub-Signature-256 is accepted
 *   - a tampered body / bad signature is rejected with 401
 *   - a duplicate delivery creates no second ticket or message
 *
 * Usage: BASE_URL=http://127.0.0.1:3000 node scripts/smoke-webhook.mjs
 */
import 'dotenv/config';
import { createHmac } from 'node:crypto';
import pg from 'pg';

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:3000';
const APP_SECRET = process.env.WHATSAPP_APP_SECRET;
const VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN;

if (!APP_SECRET || !VERIFY_TOKEN) {
  console.error(
    'Set WHATSAPP_APP_SECRET and WHATSAPP_VERIFY_TOKEN to run this check.',
  );
  process.exit(1);
}

let failures = 0;
const ok = (m) => console.log(`    ✔ ${m}`);
const bad = (m) => {
  console.error(`    ✖ ${m}`);
  failures += 1;
};

function sign(body) {
  return `sha256=${createHmac('sha256', APP_SECRET).update(body).digest('hex')}`;
}

const waId = `62899${Date.now().toString().slice(-7)}`;
const messageId = `wamid.HTTP${Date.now()}`;

const payload = JSON.stringify({
  object: 'whatsapp_business_account',
  entry: [
    {
      id: 'waba-smoke',
      changes: [
        {
          field: 'messages',
          value: {
            messaging_product: 'whatsapp',
            metadata: { phone_number_id: '1234567890' },
            contacts: [{ wa_id: waId, profile: { name: 'Smoke Tester' } }],
            messages: [
              {
                id: messageId,
                from: waId,
                timestamp: String(Math.floor(Date.now() / 1000)),
                type: 'text',
                text: { body: 'Mau order FO-SAK-C101 sebanyak 5 pcs' },
              },
            ],
          },
        },
      ],
    },
  ],
});

async function main() {
  console.log('=== WhatsApp webhook HTTP checks ===');

  /* ----------------------------------------- GET handshake ------------- */
  console.log('\n[1] Subscription handshake');
  const challenge = 'challenge-12345';
  const good = await fetch(
    `${BASE}/api/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=${encodeURIComponent(VERIFY_TOKEN)}&hub.challenge=${challenge}`,
  );
  const echoed = await good.text();
  good.status === 200 && echoed === challenge
    ? ok(`200 and echoed the challenge verbatim`)
    : bad(`expected 200 + "${challenge}", got ${good.status} "${echoed}"`);

  const wrong = await fetch(
    `${BASE}/api/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=${challenge}`,
  );
  wrong.status === 403
    ? ok('wrong verify token rejected with 403')
    : bad(`expected 403 for a wrong token, got ${wrong.status}`);

  /* ------------------------------------ POST bad signature ------------- */
  console.log('\n[2] Signature verification');
  const tampered = await fetch(`${BASE}/api/webhooks/whatsapp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-hub-signature-256': sign(`${payload} tampered`),
    },
    body: payload,
  });
  tampered.status === 401
    ? ok('mismatched signature rejected with 401')
    : bad(`expected 401 for a bad signature, got ${tampered.status}`);

  const unsigned = await fetch(`${BASE}/api/webhooks/whatsapp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: payload,
  });
  unsigned.status === 401
    ? ok('missing signature header rejected with 401')
    : bad(`expected 401 for a missing signature, got ${unsigned.status}`);

  /* --------------------------------------- POST valid delivery --------- */
  console.log('\n[3] Valid delivery');
  const first = await fetch(`${BASE}/api/webhooks/whatsapp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-hub-signature-256': sign(payload),
    },
    body: payload,
  });
  const firstBody = await first.json();
  first.status === 200 && firstBody.processed === 1
    ? ok(`200, processed=${firstBody.processed}`)
    : bad(`expected processed=1, got ${first.status} ${JSON.stringify(firstBody)}`);

  /* ------------------------------------------ duplicate delivery ------- */
  console.log('\n[4] Duplicate delivery (Meta retry)');
  const second = await fetch(`${BASE}/api/webhooks/whatsapp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-hub-signature-256': sign(payload),
    },
    body: payload,
  });
  const secondBody = await second.json();
  second.status === 200 && secondBody.duplicates === 1 && secondBody.processed === 0
    ? ok(`200, duplicates=${secondBody.duplicates}, processed=0`)
    : bad(`expected duplicates=1 processed=0, got ${JSON.stringify(secondBody)}`);

  /* ------------------------------------------- database assertions ----- */
  console.log('\n[5] Database state');
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  const tickets = await client.query(
    `SELECT t.id, t.number, t.subject, t.source, t.status
       FROM tickets t
       JOIN external_messages em ON em."ticketId" = t.id
      WHERE em."externalId" = $1`,
    [messageId],
  );
  tickets.rowCount === 1
    ? ok(`exactly 1 ticket created (${tickets.rows[0].number}, source=${tickets.rows[0].source})`)
    : bad(`expected 1 ticket, found ${tickets.rowCount}`);

  if (tickets.rowCount === 1) {
    const ticketId = tickets.rows[0].id;
    const messages = await client.query(
      'SELECT count(*)::int AS n FROM ticket_messages WHERE "ticketId" = $1',
      [ticketId],
    );
    messages.rows[0].n === 1
      ? ok('exactly 1 ticket message (no duplicate from the retry)')
      : bad(`expected 1 message, found ${messages.rows[0].n}`);

    const drafts = await client.query(
      'SELECT number, "needsReview" FROM order_drafts WHERE "ticketId" = $1',
      [ticketId],
    );
    drafts.rowCount >= 1
      ? ok(`extraction ran: draft ${drafts.rows[0].number} created from the webhook`)
      : bad('no order draft produced from the inbound message');
  }

  const events = await client.query(
    `SELECT status, count(*)::int AS n FROM processed_webhook_events
      WHERE "eventId" = $1 GROUP BY status`,
    [messageId],
  );
  const total = events.rows.reduce((a, r) => a + r.n, 0);
  total === 1
    ? ok('exactly 1 webhook-event row (the idempotency gate)')
    : bad(`expected 1 event row, found ${total}`);

  await client.end();

  console.log(
    failures === 0 ? '\n=== WEBHOOK CHECKS PASSED ===' : `\n=== ${failures} CHECK(S) FAILED ===`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('✖ error:', error);
  process.exit(1);
});
