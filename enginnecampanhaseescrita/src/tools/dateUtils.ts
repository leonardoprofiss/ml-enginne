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

/** Converte um ISO 8601 completo para YYYY-MM-DD (formato exigido pela Advertising API). */
export function toYmd(iso: string): string {
  return iso.slice(0, 10);
}

/** Como `lastNDays`, mas em YYYY-MM-DD — usado pelas tools de Campanhas (Advertising API). */
export function lastNDaysYmd(days: number): PeriodRange {
  const p = lastNDays(days);
  return { from: toYmd(p.from), to: toYmd(p.to), label: p.label };
}
