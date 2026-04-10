/** Día de la semana como en JavaScript: 0 = domingo … 6 = sábado. */

const WEEKDAY_TO_DOW: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

export type ZonedCalendarParts = {
  y: number;
  m: number;
  d: number;
  hour: number;
  minute: number;
  /** 0 = domingo … 6 = sábado */
  dow: number;
};

/**
 * Partes de fecha/hora en una zona IANA (ej. America/Bogota).
 * Usa Intl; no requiere dependencias.
 */
export function getZonedCalendarParts(date: Date, timeZone: string): ZonedCalendarParts {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  const parts = dtf.formatToParts(date);
  const map: Record<string, string> = {};
  for (const p of parts) {
    if (p.type !== 'literal') map[p.type] = p.value;
  }
  const wk = map.weekday;
  const dow = wk !== undefined && wk in WEEKDAY_TO_DOW ? WEEKDAY_TO_DOW[wk]! : 0;
  return {
    y: Number(map.year),
    m: Number(map.month),
    d: Number(map.day),
    hour: Number(map.hour),
    minute: Number(map.minute),
    dow,
  };
}

export function formatDayKey(parts: Pick<ZonedCalendarParts, 'y' | 'm' | 'd'>): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${parts.y}-${pad(parts.m)}-${pad(parts.d)}`;
}
