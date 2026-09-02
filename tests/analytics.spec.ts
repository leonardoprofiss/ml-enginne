import { describe, it, expect } from "vitest";
import {
  aggregateOrdersByItem,
  computeTotals,
  compareItemAggregates,
  topGrowth,
  topDrops,
  noSalesInCurrent,
  pctChange,
} from "../src/tools/analytics.js";
import type { MlOrder } from "../src/mercadolivre/endpoints.js";

function makeOrder(overrides: Partial<MlOrder> & { itemId: string; quantity: number; unitPrice: number }): MlOrder {
  return {
    id: Math.floor(Math.random() * 1e9),
    date_created: overrides.date_created ?? "2026-08-01T00:00:00.000Z",
    date_closed: null,
    status: overrides.status ?? "paid",
    total_amount: overrides.quantity * overrides.unitPrice,
    currency_id: "BRL",
    order_items: [
      {
        item: { id: overrides.itemId, title: `Produto ${overrides.itemId}` },
        quantity: overrides.quantity,
        unit_price: overrides.unitPrice,
      },
    ],
  } as MlOrder;
}

describe("aggregateOrdersByItem", () => {
  it("soma quantidade e receita por item, ignorando pedidos não pagos", () => {
    const orders = [
      makeOrder({ itemId: "MLB1", quantity: 2, unitPrice: 10 }),
      makeOrder({ itemId: "MLB1", quantity: 1, unitPrice: 10 }),
      makeOrder({ itemId: "MLB2", quantity: 5, unitPrice: 20 }),
      makeOrder({ itemId: "MLB3", quantity: 99, unitPrice: 1, status: "cancelled" }),
    ];
    const map = aggregateOrdersByItem(orders);
    expect(map.get("MLB1")?.quantity).toBe(3);
    expect(map.get("MLB1")?.revenue).toBe(30);
    expect(map.get("MLB2")?.revenue).toBe(100);
    expect(map.has("MLB3")).toBe(false); // cancelado não conta
  });

  it("mantém a data da última venda por item", () => {
    const orders = [
      makeOrder({ itemId: "MLB1", quantity: 1, unitPrice: 10, date_created: "2026-08-01T00:00:00.000Z" }),
      makeOrder({ itemId: "MLB1", quantity: 1, unitPrice: 10, date_created: "2026-08-15T00:00:00.000Z" }),
    ];
    const map = aggregateOrdersByItem(orders);
    expect(map.get("MLB1")?.lastSaleDate).toBe("2026-08-15T00:00:00.000Z");
  });
});

describe("computeTotals", () => {
  it("calcula faturamento, pedidos, unidades e ticket médio corretamente", () => {
    const orders = [
      makeOrder({ itemId: "MLB1", quantity: 2, unitPrice: 50 }), // total_amount = 100
      makeOrder({ itemId: "MLB2", quantity: 1, unitPrice: 200 }), // total_amount = 200
    ];
    const totals = computeTotals(orders);
    expect(totals.revenue).toBe(300);
    expect(totals.orders).toBe(2);
    expect(totals.units).toBe(3);
    expect(totals.avgTicket).toBe(150);
  });

  it("retorna zeros quando não há pedidos pagos", () => {
    const totals = computeTotals([]);
    expect(totals).toEqual({ revenue: 0, orders: 0, units: 0, avgTicket: 0 });
  });
});

describe("pctChange", () => {
  it("calcula variação percentual normal", () => {
    expect(pctChange(150, 100)).toBe(50);
    expect(pctChange(50, 100)).toBe(-50);
  });
  it("trata base zero sem dividir por zero", () => {
    expect(pctChange(0, 0)).toBe(0);
    expect(pctChange(10, 0)).toBe(100);
  });
});

describe("compareItemAggregates + topGrowth/topDrops/noSalesInCurrent", () => {
  const current = aggregateOrdersByItem([
    makeOrder({ itemId: "MLB1", quantity: 10, unitPrice: 10 }), // cresceu
    makeOrder({ itemId: "MLB2", quantity: 1, unitPrice: 10 }), // caiu
  ]);
  const previous = aggregateOrdersByItem([
    makeOrder({ itemId: "MLB1", quantity: 2, unitPrice: 10 }),
    makeOrder({ itemId: "MLB2", quantity: 10, unitPrice: 10 }),
    makeOrder({ itemId: "MLB3", quantity: 5, unitPrice: 10 }), // zerou no período atual
  ]);
  const comparisons = compareItemAggregates(current, previous);

  it("inclui todos os itens de ambos os períodos", () => {
    const ids = comparisons.map((c) => c.itemId).sort();
    expect(ids).toEqual(["MLB1", "MLB2", "MLB3"]);
  });

  it("identifica o item que mais cresceu", () => {
    const [top] = topGrowth(comparisons, 1);
    expect(top.itemId).toBe("MLB1");
  });

  it("identifica o item que mais caiu", () => {
    const [top] = topDrops(comparisons, 1);
    expect(top.itemId).toBe("MLB2");
  });

  it("identifica produtos que zeraram vendas", () => {
    const zeroed = noSalesInCurrent(comparisons);
    expect(zeroed.map((z) => z.itemId)).toEqual(["MLB3"]);
  });
});
