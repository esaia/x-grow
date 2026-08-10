/**
 * Wall-clock time handling.
 *
 * Scheduled posts store a **naive** local timestamp ("2026-08-12T09:00") next
 * to the IANA timezone it was picked in. That pairing is deliberate: 9:00 AM
 * has to stay 9:00 AM in the zone the user chose it, even if they travel. The
 * cost is that you can never `new Date(scheduled_at)` and trust the result, so
 * every conversion goes through here.
 */

/** "2026-08-12T09:00" — the canonical naive format used in scheduled_at. */
export type NaiveDateTime = string;

const NAIVE = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/;

export function localTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

/** Build a naive timestamp from a "YYYY-MM-DD" date and an "HH:MM" time. */
export function naive(date: string, time: string): NaiveDateTime {
  return `${date}T${time.slice(0, 5)}`;
}

/** The "YYYY-MM-DD" half of a naive timestamp. */
export function dateOf(value: NaiveDateTime): string {
  return value.slice(0, 10);
}

/**
 * The "HH:MM" half of a naive timestamp, read straight out of the string.
 * Never go via Date + toLocaleTimeString here — that reinterprets the stored
 * value in the browser's zone and shifts what the user sees.
 */
export function timeOf(value: NaiveDateTime): string {
  return value.slice(11, 16);
}

/**
 * The real instant a naive timestamp refers to, in epoch milliseconds.
 * Ported from ScheduledPost::realScheduledAt().
 */
export function realInstant(
  value: NaiveDateTime,
  timeZone: string | null,
): number {
  const match = NAIVE.exec(value);

  if (!match) {
    return Number.NaN;
  }

  const [, y, mo, d, h, mi] = match.map(Number) as unknown as number[];
  const asUtc = Date.UTC(y, mo - 1, d, h, mi);

  if (!timeZone) {
    // No zone recorded: treat the digits as the browser's own local time.
    return new Date(y, mo - 1, d, h, mi).getTime();
  }

  // Subtracting the zone's offset at a guessed instant lands within an hour of
  // the answer; re-checking the offset there fixes DST boundary cases.
  const first = asUtc - zoneOffset(asUtc, timeZone);
  const second = asUtc - zoneOffset(first, timeZone);

  return second;
}

/** How far ahead of UTC `timeZone` is at a given instant, in milliseconds. */
function zoneOffset(utcMs: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(utcMs));

  const read: Record<string, number> = {};

  for (const part of parts) {
    if (part.type !== 'literal') {
      read[part.type] = Number(part.value);
    }
  }

  const local = Date.UTC(
    read.year,
    read.month - 1,
    read.day,
    // Some engines render midnight as hour 24 under hour12: false.
    read.hour % 24,
    read.minute,
    read.second,
  );

  return local - utcMs;
}

/** "YYYY-MM-DD" for a Date, in local time (not UTC — toISOString would shift). */
export function dateKey(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');

  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** "HH:MM" for a Date, in local time. */
export function timeKey(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');

  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** The Monday of the week containing `date`, as "YYYY-MM-DD". */
export function weekStart(date: Date): string {
  const monday = new Date(date);
  const weekday = (monday.getDay() + 6) % 7; // Mon = 0

  monday.setDate(monday.getDate() - weekday);
  monday.setHours(0, 0, 0, 0);

  return dateKey(monday);
}

/** Shift a "YYYY-MM-DD" key by whole days. */
export function addDays(key: string, days: number): string {
  const [y, m, d] = key.split('-').map(Number);
  const date = new Date(y, m - 1, d + days);

  return dateKey(date);
}
