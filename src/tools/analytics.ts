import type { MlOrder } from "../mercadolivre/endpoints.js";

/**
 * Funções PURAS de agregação (sem I/O), para poderem ser testadas com
 * `vitest` sem precisar de rede nem de um seller autorizado de verdade.
 * As tools em analises.ts só buscam os dados brutos e chamam estas funções.
 */

export interface ItemAggregate {
  itemId: string;
  title: string;
  quantity: number;
  revenue: number;
  lastSaleDate: string | null;
}

const PAID_STATUSES = new Set(["paid", "confirmed"]);

export function aggregateOrdersByItem(orders: MlOrder[], onlyPaid = true): Map<string, ItemAggregate> {
  const map = new Map<string, ItemAggregate>();
  for (const order of orders) {
    if (onlyPaid && !PAID_STATUSES.has(order.status)) continue;
    for (const oi of order.order_items) {
      const id = oi.item.id;
      const existing = map.get(id);
      const revenue = oi.unit_price * oi.quantity;
      if (existing) {
        existing.quantity += oi.quantity;
        existing.revenue += revenue;
        if (!existing.lastSaleDate || order.date_created > existing.lastSaleDate) {
          existing.lastSaleDate = order.date_created;
        }
      } else {
        map.set(id, {
          itemId: id,
          title: oi.item.title,
          quantity: oi.quantity,
          revenue,
          lastSaleDate: order.date_created,
        });
      }
    }
  }
  return map;
}

export interface PeriodTotals {
  revenue: number;
  orders: number;
  units: number;
  avgTicket: number;
}

export function computeTotals(orders: MlOrder[]): PeriodTotals {
  const paid = orders.filter((o) => PAID_STATUSES.has(o.status));
  const revenue = paid.reduce((s, o) => s + o.total_amount, 0);
  const units = paid.reduce((s, o) => s + o.order_items.reduce((u, oi) => u + oi.quantity, 0), 0);
  return {
    revenue,
    orders: paid.length,
    units,
    avgTicket: paid.length > 0 ? revenue / paid.length : 0,
  };
}

export function pctChange(current: number, previous: number): number | null {
  if (previous === 0) return current > 0 ? 100 : 0;
  return ((current - previous) / previous) * 100;
}

export interface ItemComparison {
  itemId: string;
  title: string;
  currentQty: number;
  previousQty: number;
  currentRevenue: number;
  previousRevenue: number;
  qtyChangePct: number | null;
  revenueChangePct: number | null;
}

export function compareItemAggregates(
  current: Map<string, ItemAggregate>,
  previous: Map<string, ItemAggregate>
): ItemComparison[] {
  const ids = new Set([...current.keys(), ...previous.keys()]);
  const out: ItemComparison[] = [];
  for (const id of ids) {
    const cur = current.get(id);
    const prev = previous.get(id);
    out.push({
      itemId: id,
      title: cur?.title ?? prev?.title ?? id,
      currentQty: cur?.quantity ?? 0,
      previousQty: prev?.quantity ?? 0,
      currentRevenue: cur?.revenue ?? 0,
      previousRevenue: prev?.revenue ?? 0,
      qtyChangePct: pctChange(cur?.quantity ?? 0, prev?.quantity ?? 0),
      revenueChangePct: pctChange(cur?.revenue ?? 0, prev?.revenue ?? 0),
    });
  }
  return out;
}

export function topGrowth(comparisons: ItemComparison[], n = 10): ItemComparison[] {
  return [...comparisons]
    .filter((c) => c.currentRevenue - c.previousRevenue > 0)
    .sort((a, b) => b.currentRevenue - b.previousRevenue - (a.currentRevenue - a.previousRevenue))
    .slice(0, n);
}

export function topDrops(comparisons: ItemComparison[], n = 10): ItemComparison[] {
  return [...comparisons]
    .filter((c) => c.currentRevenue - c.previousRevenue < 0)
    .sort((a, b) => a.currentRevenue - a.previousRevenue - (b.currentRevenue - b.previousRevenue))
    .slice(0, n);
}

export function noSalesInCurrent(comparisons: ItemComparison[]): ItemComparison[] {
  return comparisons.filter((c) => c.currentQty === 0 && c.previousQty > 0);
}
