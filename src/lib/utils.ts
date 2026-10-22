import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/** Tailwind-aware class merge: later classes win over earlier conflicts. */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * Formats an instant in the configured application timezone.
 * Everything is stored in UTC; this is the only place display conversion
 * should happen.
 */
export function formatDateTime(
  value: Date | string | null | undefined,
  options: {
    timeZone?: string;
    locale?: string;
    style?: 'short' | 'medium' | 'long' | 'date' | 'time';
  } = {},
): string {
  if (!value) return '—';
  const date = typeof value === 'string' ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return '—';

  const timeZone = options.timeZone ?? 'Asia/Jakarta';
  const locale = options.locale ?? 'id-ID';

  const formats: Record<string, Intl.DateTimeFormatOptions> = {
    short: { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' },
    medium: {
      day: '2-digit', month: 'short', year: 'numeric',
      hour: '2-digit', minute: '2-digit',
    },
    long: {
      weekday: 'short', day: '2-digit', month: 'long', year: 'numeric',
      hour: '2-digit', minute: '2-digit',
    },
    date: { day: '2-digit', month: 'short', year: 'numeric' },
    time: { hour: '2-digit', minute: '2-digit' },
  };

  return new Intl.DateTimeFormat(locale, {
    ...formats[options.style ?? 'medium'],
    timeZone,
  }).format(date);
}

/** "3 menit lalu" style relative time for the ticket inbox. */
export function formatRelative(
  value: Date | string | null | undefined,
  now: Date = new Date(),
): string {
  if (!value) return '—';
  const date = typeof value === 'string' ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return '—';

  const seconds = Math.round((now.getTime() - date.getTime()) / 1000);
  const future = seconds < 0;
  const abs = Math.abs(seconds);

  const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ['second', 60],
    ['minute', 60],
    ['hour', 24],
    ['day', 7],
    ['week', 4.34524],
    ['month', 12],
    ['year', Number.POSITIVE_INFINITY],
  ];

  let value_ = abs;
  for (const [unit, divisor] of units) {
    if (value_ < divisor) {
      const rtf = new Intl.RelativeTimeFormat('id-ID', { numeric: 'auto' });
      return rtf.format(
        future ? Math.round(value_) : -Math.round(value_),
        unit,
      );
    }
    value_ /= divisor;
  }
  return '—';
}

/** Initials for an avatar placeholder. */
export function initials(name: string | null | undefined): string {
  if (!name) return '?';
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? '')
    .join('');
}

export function truncate(value: string, max = 80): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

/** Turns an enum member like AWAITING_CUSTOMER into "Awaiting customer". */
export function humanise(value: string): string {
  const lower = value.replace(/_/g, ' ').toLowerCase();
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}
