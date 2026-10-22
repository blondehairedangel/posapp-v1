'use client';

import * as React from 'react';
import {
  AlertTriangle,
  Check,
  CheckCheck,
  Clock,
  Eye,
  Lock,
  Send,
  Sparkles,
} from 'lucide-react';
import { cn, formatDateTime, initials } from '@/lib/utils';
import { Textarea } from '@/components/ui/form-fields';
import { Alert, Spinner, useToast } from '@/components/ui/feedback';
import { Button } from '@/components/ui/button';
import {
  addNoteAction,
  extractFromMessageAction,
  replyAction,
} from '@/server/actions/tickets';
import type { DeliveryStatus } from '@/generated/prisma/client';

export interface ConversationMessage {
  id: string;
  direction: 'INBOUND' | 'OUTBOUND';
  visibility: 'PUBLIC' | 'INTERNAL';
  channel: string;
  bodyText: string;
  authorName: string | null;
  author: { id: string; name: string } | null;
  createdAt: Date;
  deliveryStatus: DeliveryStatus;
  attachments: Array<{ id: string; file: { id: string; filename: string } }>;
  outboundAttempts: Array<{
    status: DeliveryStatus;
    errorMessage: string | null;
  }>;
}

function DeliveryIndicator({
  message,
}: {
  message: ConversationMessage;
}) {
  if (message.direction === 'INBOUND') return null;
  if (message.visibility === 'INTERNAL') return null;

  const failure = message.outboundAttempts.find((a) => a.status === 'FAILED');

  if (message.deliveryStatus === 'FAILED' || failure) {
    return (
      <span
        className="inline-flex items-center gap-1 text-danger"
        title={failure?.errorMessage ?? 'Delivery failed'}
      >
        <AlertTriangle className="size-3" aria-hidden />
        Not delivered
      </span>
    );
  }

  const map: Partial<Record<DeliveryStatus, React.ReactNode>> = {
    PENDING: (
      <span className="inline-flex items-center gap-1 text-fg-subtle">
        <Clock className="size-3" aria-hidden /> Pending
      </span>
    ),
    QUEUED: (
      <span className="inline-flex items-center gap-1 text-fg-subtle">
        <Clock className="size-3" aria-hidden /> Queued
      </span>
    ),
    SENT: (
      <span className="inline-flex items-center gap-1 text-fg-subtle">
        <Check className="size-3" aria-hidden /> Sent
      </span>
    ),
    DELIVERED: (
      <span className="inline-flex items-center gap-1 text-fg-subtle">
        <CheckCheck className="size-3" aria-hidden /> Delivered
      </span>
    ),
    READ: (
      <span className="inline-flex items-center gap-1 text-info">
        <Eye className="size-3" aria-hidden /> Read
      </span>
    ),
  };

  return <>{map[message.deliveryStatus] ?? null}</>;
}

export function Conversation({
  ticketId,
  messages,
  timeZone,
  canReply,
  canNote,
  canExtract,
}: {
  ticketId: string;
  messages: ConversationMessage[];
  timeZone: string;
  canReply: boolean;
  canNote: boolean;
  canExtract: boolean;
}) {
  const bottomRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end' });
  }, [messages.length]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto scrollbar-thin p-4">
        {messages.length === 0 ? (
          <p className="py-8 text-center text-xs text-fg-subtle">
            No messages on this ticket yet.
          </p>
        ) : (
          messages.map((message) => (
            <MessageBubble
              key={message.id}
              message={message}
              ticketId={ticketId}
              timeZone={timeZone}
              canExtract={canExtract}
            />
          ))
        )}
        <div ref={bottomRef} />
      </div>

      {canReply || canNote ? (
        <Composer ticketId={ticketId} canReply={canReply} canNote={canNote} />
      ) : (
        <div className="border-t border-border p-3">
          <Alert tone="info">
            Your role can view this conversation but not post to it.
          </Alert>
        </div>
      )}
    </div>
  );
}

function MessageBubble({
  message,
  ticketId,
  timeZone,
  canExtract,
}: {
  message: ConversationMessage;
  ticketId: string;
  timeZone: string;
  canExtract: boolean;
}) {
  const toast = useToast();
  const [pending, setPending] = React.useState(false);
  const internal = message.visibility === 'INTERNAL';
  const inbound = message.direction === 'INBOUND';

  async function extract() {
    setPending(true);
    const fd = new FormData();
    fd.set('ticketId', ticketId);
    fd.set('messageId', message.id);
    const result = await extractFromMessageAction(fd);
    setPending(false);
    toast.push(
      result.ok ? 'success' : 'danger',
      result.ok ? (result.message ?? 'Done') : result.error,
    );
  }

  return (
    <article
      className={cn(
        'flex gap-2.5',
        inbound ? 'justify-start' : 'justify-end',
      )}
    >
      {inbound ? (
        <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full bg-surface-muted text-[10px] font-semibold text-fg-muted">
          {initials(message.authorName)}
        </span>
      ) : null}

      <div className={cn('max-w-[min(42rem,85%)] min-w-0')}>
        <div
          className={cn(
            'rounded-lg border px-3 py-2',
            internal
              ? // Internal notes are visually unmistakable: a customer-visible
                // reply and a private note must never be confused.
                'border-warning/40 bg-warning-subtle'
              : inbound
                ? 'border-border bg-surface'
                : 'border-primary/20 bg-primary-subtle',
          )}
        >
          <header className="mb-1 flex flex-wrap items-center gap-2 text-[11px]">
            <span className="font-semibold text-fg">
              {message.author?.name ?? message.authorName ?? 'Customer'}
            </span>
            {internal ? (
              <span className="inline-flex items-center gap-1 rounded-full bg-warning/15 px-1.5 py-0.5 font-semibold text-warning">
                <Lock className="size-2.5" aria-hidden />
                Internal note — not sent to customer
              </span>
            ) : (
              <span className="text-fg-subtle">{message.channel}</span>
            )}
            <span className="text-fg-subtle">
              {formatDateTime(message.createdAt, { timeZone, style: 'short' })}
            </span>
          </header>

          <div className="whitespace-pre-wrap break-words text-sm leading-relaxed text-fg">
            {message.bodyText}
          </div>

          {message.attachments.length > 0 ? (
            <ul className="mt-2 space-y-1">
              {message.attachments.map((a) => (
                <li key={a.id}>
                  <a
                    href={`/api/files/${a.file.id}`}
                    className="text-xs text-primary underline underline-offset-2"
                  >
                    {a.file.filename}
                  </a>
                </li>
              ))}
            </ul>
          ) : null}
        </div>

        <footer
          className={cn(
            'mt-1 flex items-center gap-2 text-[11px]',
            inbound ? 'justify-start' : 'justify-end',
          )}
        >
          <DeliveryIndicator message={message} />
          {inbound && canExtract ? (
            <button
              type="button"
              onClick={extract}
              disabled={pending}
              className="inline-flex items-center gap-1 text-primary underline-offset-2 hover:underline disabled:opacity-50"
              title="Extract requested spare parts from this message into a reviewable draft"
            >
              {pending ? <Spinner className="size-3" /> : <Sparkles className="size-3" aria-hidden />}
              Extract order
            </button>
          ) : null}
        </footer>
      </div>
    </article>
  );
}

function Composer({
  ticketId,
  canReply,
  canNote,
}: {
  ticketId: string;
  canReply: boolean;
  canNote: boolean;
}) {
  const toast = useToast();
  const [mode, setMode] = React.useState<'reply' | 'note'>(
    canReply ? 'reply' : 'note',
  );
  const [body, setBody] = React.useState('');
  const [pending, setPending] = React.useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!body.trim()) return;
    setPending(true);

    const fd = new FormData();
    fd.set('ticketId', ticketId);
    fd.set('body', body);

    const result =
      mode === 'reply' ? await replyAction(fd) : await addNoteAction(fd);

    setPending(false);
    if (result.ok) {
      setBody('');
      toast.push(
        result.message?.includes('NOT delivered') ? 'warning' : 'success',
        result.message ?? 'Posted',
      );
    } else {
      toast.push('danger', result.error);
    }
  }

  return (
    <form
      onSubmit={submit}
      className={cn(
        'border-t p-3',
        mode === 'note'
          ? 'border-warning/40 bg-warning-subtle/40'
          : 'border-border bg-surface',
      )}
    >
      <div
        role="tablist"
        aria-label="Composer mode"
        className="mb-2 flex gap-1"
      >
        {canReply ? (
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'reply'}
            onClick={() => setMode('reply')}
            className={cn(
              'rounded-md px-2.5 py-1 text-xs font-medium transition-colors',
              mode === 'reply'
                ? 'bg-primary text-primary-fg'
                : 'text-fg-muted hover:bg-surface-muted',
            )}
          >
            Reply to customer
          </button>
        ) : null}
        {canNote ? (
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'note'}
            onClick={() => setMode('note')}
            className={cn(
              'inline-flex items-center gap-1 rounded-md px-2.5 py-1 text-xs font-medium transition-colors',
              mode === 'note'
                ? 'bg-warning text-white'
                : 'text-fg-muted hover:bg-surface-muted',
            )}
          >
            <Lock className="size-3" aria-hidden />
            Internal note
          </button>
        ) : null}
      </div>

      {mode === 'note' ? (
        <p className="mb-1.5 text-[11px] font-medium text-warning">
          This note stays inside the application. It is never emailed or sent
          over WhatsApp.
        </p>
      ) : null}

      <Textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        placeholder={
          mode === 'reply'
            ? 'Write a reply the customer will receive…'
            : 'Write a note for your colleagues…'
        }
        aria-label={mode === 'reply' ? 'Reply to customer' : 'Internal note'}
        rows={3}
        onKeyDown={(e) => {
          // Ctrl/Cmd+Enter submits; plain Enter inserts a newline, because
          // these messages are often multi-line part lists.
          if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
            void submit(e);
          }
        }}
      />

      <div className="mt-2 flex items-center justify-between gap-2">
        <span className="text-[11px] text-fg-subtle">
          Ctrl/⌘ + Enter to send
        </span>
        <Button type="submit" size="sm" disabled={pending || !body.trim()}>
          {pending ? <Spinner /> : <Send aria-hidden />}
          {mode === 'reply' ? 'Send reply' : 'Add note'}
        </Button>
      </div>
    </form>
  );
}
