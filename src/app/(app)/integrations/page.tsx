import { prisma } from '@/lib/db';
import { env, integrationStatus } from '@/lib/env';
import { formatDateTime } from '@/lib/utils';
import { requirePagePermission } from '@/server/auth/guard';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert } from '@/components/ui/feedback';
import {
  TBody,
  TD,
  TH,
  THead,
  TR,
  Table,
  EmptyState,
  TableEmptyRow,
} from '@/components/ui/table';

export const metadata = { title: 'Integrations' };

/**
 * Integration status.
 *
 * This page deliberately reports what is *actually* configured, derived from
 * the environment and from real webhook/message records. It never claims a
 * channel is live, and it names the exact variables that are missing so the
 * operator knows what to supply.
 */
export default async function IntegrationsPage() {
  await requirePagePermission('integration:manage', '/integrations');

  const status = integrationStatus();
  const appUrl = env().APP_URL;

  const [channels, recentEvents, mailboxes, failedOutbound] = await Promise.all([
    prisma.communicationChannel.findMany({
      orderBy: { key: 'asc' },
      include: {
        department: { select: { name: true } },
        _count: { select: { tickets: true, externalMsgs: true } },
      },
    }),
    prisma.processedWebhookEvent.findMany({
      orderBy: { receivedAt: 'desc' },
      take: 15,
    }),
    prisma.emailMailbox.findMany({
      include: { department: { select: { name: true } } },
    }),
    prisma.outboundMessageAttempt.count({ where: { status: 'FAILED' } }),
  ]);

  const timeZone = env().APP_TIMEZONE;

  return (
    <div className="space-y-4 p-4 lg:p-6">
      <div>
        <h1 className="text-lg font-semibold tracking-tight">Integrations</h1>
        <p className="text-xs text-fg-muted">
          Live configuration status. Nothing on this page is simulated — a
          channel shown as not configured genuinely cannot send or receive.
        </p>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        {/* WhatsApp */}
        <Card>
          <CardHeader>
            <CardTitle>WhatsApp Business Cloud API</CardTitle>
            <Badge tone={status.whatsapp.configured ? 'success' : 'warning'}>
              {status.whatsapp.configured ? 'Configured' : 'Not configured'}
            </Badge>
          </CardHeader>
          <CardContent className="space-y-2 text-xs">
            {!status.whatsapp.configured ? (
              <Alert tone="warning" title="Activation required">
                Set these environment variables, then restart:
                <ul className="mt-1 list-inside list-disc font-mono text-[11px]">
                  {status.whatsapp.missing.map((m) => (
                    <li key={m}>{m}</li>
                  ))}
                </ul>
              </Alert>
            ) : null}

            {status.whatsapp.configured && !status.whatsapp.signatureVerifiable ? (
              <Alert tone="danger" title="Signature verification disabled">
                <code className="font-mono">WHATSAPP_APP_SECRET</code> is unset.
                Inbound webhooks are rejected in production because an unsigned
                webhook would let anyone inject messages.
              </Alert>
            ) : null}

            <dl className="space-y-1">
              <Row
                label="Webhook callback URL"
                value={`${appUrl}/api/webhooks/whatsapp`}
                mono
              />
              <Row label="API version" value={env().WHATSAPP_API_VERSION} mono />
              <Row
                label="Signature verification"
                value={
                  status.whatsapp.signatureVerifiable
                    ? 'Enabled (X-Hub-Signature-256)'
                    : 'Not available — app secret missing'
                }
              />
            </dl>

            <p className="text-[11px] text-fg-subtle">
              Paste the callback URL and your verify token into Meta&apos;s App
              Dashboard → WhatsApp → Configuration. Free-form replies are only
              permitted inside the 24-hour customer service window; outside it
              WhatsApp requires an approved template.
            </p>
          </CardContent>
        </Card>

        {/* Email */}
        <Card>
          <CardHeader>
            <CardTitle>Email (SMTP out / IMAP in)</CardTitle>
            <Badge tone={status.smtp.configured ? 'success' : 'warning'}>
              {status.smtp.configured ? 'SMTP configured' : 'Not configured'}
            </Badge>
          </CardHeader>
          <CardContent className="space-y-2 text-xs">
            {!status.smtp.configured ? (
              <Alert tone="warning" title="Activation required">
                Set these environment variables, then restart:
                <ul className="mt-1 list-inside list-disc font-mono text-[11px]">
                  {status.smtp.missing.map((m) => (
                    <li key={m}>{m}</li>
                  ))}
                </ul>
              </Alert>
            ) : null}

            <dl className="space-y-1">
              <Row label="SMTP host" value={env().SMTP_HOST ?? '—'} mono />
              <Row label="From address" value={env().SMTP_FROM_ADDRESS ?? '—'} mono />
              <Row
                label="Inbound mailboxes"
                value={`${mailboxes.length} configured`}
              />
              <Row
                label="Poll interval"
                value={`${env().EMAIL_POLL_INTERVAL_SECONDS}s (background worker)`}
              />
            </dl>

            {mailboxes.length === 0 ? (
              <p className="text-[11px] text-fg-subtle">
                No IMAP mailbox is registered, so inbound email is not being
                polled. Add one per department to route mail automatically.
              </p>
            ) : (
              <ul className="space-y-1">
                {mailboxes.map((m) => (
                  <li key={m.id} className="flex items-center justify-between gap-2">
                    <span className="font-mono text-[11px]">{m.address}</span>
                    <span className="flex items-center gap-1.5">
                      <Badge tone={m.status === 'ACTIVE' ? 'success' : 'neutral'}>
                        {m.status}
                      </Badge>
                      {m.lastError ? (
                        <Badge tone="danger">error</Badge>
                      ) : null}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        {/* AI */}
        <Card>
          <CardHeader>
            <CardTitle>AI order extraction</CardTitle>
            <Badge tone={status.ai.configured ? 'success' : 'info'}>
              {status.ai.configured
                ? `Active (${status.ai.provider})`
                : 'Deterministic parser'}
            </Badge>
          </CardHeader>
          <CardContent className="space-y-2 text-xs">
            <Alert tone="info">
              The ERP does not require an AI provider. With AI disabled, order
              extraction uses a rule-based parser that handles SKUs,
              quantities and units. The LLM, when configured, only segments the
              customer&apos;s text — products, prices and stock always come from
              the database.
            </Alert>
            <dl className="space-y-1">
              <Row
                label="Provider"
                value={status.ai.enabled ? status.ai.provider : 'disabled'}
                mono
              />
              <Row
                label="Auto-match threshold"
                value={`${Math.round(env().EXTRACTION_AUTO_MATCH_THRESHOLD * 100)}% — below this a human reviews`}
              />
            </dl>
          </CardContent>
        </Card>

        {/* Health */}
        <Card>
          <CardHeader>
            <CardTitle>Delivery health</CardTitle>
            {failedOutbound > 0 ? (
              <Badge tone="danger">{failedOutbound} failed</Badge>
            ) : (
              <Badge tone="success">No failures</Badge>
            )}
          </CardHeader>
          <CardContent className="space-y-1 text-xs">
            {channels.map((c) => (
              <div
                key={c.id}
                className="flex items-center justify-between gap-2 border-b border-border py-1 last:border-0"
              >
                <span>
                  <span className="font-medium">{c.name}</span>
                  <span className="ml-1 text-[11px] text-fg-subtle">
                    {c.department?.name ?? 'no department'}
                  </span>
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="num text-[11px] text-fg-subtle">
                    {c._count.tickets} tickets
                  </span>
                  <Badge tone={c.status === 'ACTIVE' ? 'success' : 'neutral'}>
                    {c.status}
                  </Badge>
                </span>
              </div>
            ))}
          </CardContent>
        </Card>
      </div>

      {/* Webhook log */}
      <Card>
        <CardHeader>
          <CardTitle>Recent webhook events</CardTitle>
          <span className="text-[11px] text-fg-subtle">
            Duplicates are rejected by a unique constraint on (channel, event id)
          </span>
        </CardHeader>
        <Table>
          <THead>
            <TR>
              <TH>Received</TH>
              <TH>Channel</TH>
              <TH>Type</TH>
              <TH>Event id</TH>
              <TH>Status</TH>
              <TH>Error</TH>
            </TR>
          </THead>
          <TBody>
            {recentEvents.length === 0 ? (
              <TableEmptyRow colSpan={6}>
                <EmptyState
                  title="No webhook events received"
                  description="Events appear here as soon as a provider posts to the callback URL. This log is also the deduplication ledger."
                />
              </TableEmptyRow>
            ) : (
              recentEvents.map((e) => (
                <TR key={e.id}>
                  <TD className="whitespace-nowrap text-[11px]">
                    {formatDateTime(e.receivedAt, { timeZone, style: 'short' })}
                  </TD>
                  <TD className="text-[11px]">{e.channelType}</TD>
                  <TD className="text-[11px]">{e.eventType ?? '—'}</TD>
                  <TD className="max-w-48 truncate font-mono text-[10px]">
                    {e.eventId}
                  </TD>
                  <TD>
                    <Badge
                      tone={
                        e.status === 'PROCESSED'
                          ? 'success'
                          : e.status === 'FAILED'
                            ? 'danger'
                            : e.status === 'SKIPPED_DUPLICATE'
                              ? 'neutral'
                              : 'info'
                      }
                    >
                      {e.status}
                    </Badge>
                  </TD>
                  <TD className="max-w-56 truncate text-[11px] text-danger">
                    {e.error ?? ''}
                  </TD>
                </TR>
              ))
            )}
          </TBody>
        </Table>
      </Card>
    </div>
  );
}

function Row({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="shrink-0 text-fg-subtle">{label}</dt>
      <dd
        className={
          mono
            ? 'truncate text-right font-mono text-[11px]'
            : 'text-right text-[11px]'
        }
      >
        {value}
      </dd>
    </div>
  );
}
