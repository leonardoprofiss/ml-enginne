/** Utilitários de data para janelas de período (ex.: "últimos 30 dias"). */

export function daysAgoIso(days: number, from: Date = new Date()): string {
  const d = new Date(from);
  d.setDate(d.getDate() - days);
  return d.toISOString();
}

export function nowIso(): string {
  return new Date().toISOString();
}

export interface PeriodRange {
  from: string;
  to: string;
  label: string;
}

/** Últimos N dias, terminando agora. */
export function lastNDays(days: number): PeriodRange {
  return { from: daysAgoIso(days), to: nowIso(), label: `últimos ${days} dias` };
}

/** Período imediatamente anterior a `lastNDays(days)`, mesma duração. */
export function precedingNDays(days: number): PeriodRange {
  const to = daysAgoIso(days);
  const from = daysAgoIso(days * 2);
  return { from, to, label: `${days} dias anteriores` };
}

export function daysBetween(fromIso: string, toIso: string): number {
  const ms = new Date(toIso).getTime() - new Date(fromIso).getTime();
  return Math.max(1, Math.round(ms / 86_400_000));
}
