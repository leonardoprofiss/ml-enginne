import { z } from "zod";
import { resolveSeller } from "./resolveSeller.js";
import { ok, toErrorResult, type ToolDefinition } from "./types.js";
import { lastNDays, precedingNDays, daysAgoIso, nowIso } from "./dateUtils.js";
import { searchAllItemIds, getItemsMultiget, searchAllOrders, getItemsVisits } from "../mercadolivre/endpoints.js";
import {
  aggregateOrdersByItem,
  computeTotals,
  compareItemAggregates,
  topGrowth,
  topDrops,
  pctChange,
} from "./analytics.js";

// ---- buscar_produtos_sem_vendas ----

const semVendasSchema = {
  seller: z.string().describe("Nome interno do seller"),
  dias: z.number().int().positive().max(365).optional().describe("Janela de análise em dias (default 30)"),
  estoqueMinimo: z.number().int().nonnegative().optional().describe("Estoque mínimo para considerar o produto (default 1)"),
  limite: z.number().int().positive().max(500).optional().describe("Máximo de produtos a retornar (default 100)"),
};

export const buscarProdutosSemVendasTool: ToolDefinition<typeof semVendasSchema> = {
  name: "buscar_produtos_sem_vendas",
  title: "Buscar produtos com estoque e sem vendas",
  description:
    "Encontra anúncios ativos com estoque disponível que NÃO tiveram nenhuma venda no período informado. Para cada produto retorna SKU/MLB, título, estoque, preço, quantidade vendida no período (0), visitas no período, última venda registrada (se houver) e status do anúncio. Ideal para 'encontre produtos com estoque e sem vendas nos últimos 30 dias'.",
  inputSchema: semVendasSchema,
  handler: async ({ seller, dias, estoqueMinimo, limite }) => {
    try {
      const row = resolveSeller(seller);
      const period = lastNDays(dias ?? 30);
      const minStock = estoqueMinimo ?? 1;
      const max = limite ?? 100;

      const [itemIds, orders] = await Promise.all([
        searchAllItemIds(seller, row.ml_user_id!, 5000),
        searchAllOrders(seller, row.ml_user_id!, { dateFrom: period.from, dateTo: period.to, maxOrders: 5000 }),
      ]);

      const soldMap = aggregateOrdersByItem(orders);
      const items = await getItemsMultiget(seller, itemIds);

      const candidates = items.filter(
        (i) =>
          (i.status === "active" || i.status === "paused") &&
          i.available_quantity >= minStock &&
          !soldMap.has(i.id)
      );

      const limited = candidates.slice(0, max);
      const visits = await getItemsVisits(
        seller,
        limited.map((i) => i.id),
        period.from,
        period.to
      );

      // Última venda: procura no histórico ampliado (até 180 dias) só para os candidatos, para não
      // sobrecarregar a API em contas grandes — não faz sentido olhar 1 ano p/ cada item de um catálogo de 10k.
      const lookback = Math.max(180, dias ?? 30);
      const extendedOrders = await searchAllOrders(seller, row.ml_user_id!, {
        dateFrom: daysAgoIso(lookback),
        dateTo: nowIso(),
        maxOrders: 5000,
      });
      const extendedSoldMap = aggregateOrdersByItem(extendedOrders);

      const rows = limited.map((i) => ({
        mlb: i.id,
        titulo: i.title,
        estoque: i.available_quantity,
        preco: i.price,
        vendidoNoPeriodo: 0,
        visitasNoPeriodo: visits[i.id] ?? 0,
        ultimaVenda: extendedSoldMap.get(i.id)?.lastSaleDate ?? null,
        status: i.status,
      }));

      const lines = rows.map(
        (r) =>
          `- ${r.mlb} | ${r.titulo} | estoque: ${r.estoque} | preço: R$ ${r.preco} | visitas (${period.label}): ${r.visitasNoPeriodo} | última venda: ${r.ultimaVenda ?? `sem registro nos últimos ${lookback} dias`} | status: ${r.status}`
      );

      return ok(
        `${candidates.length} produto(s) com estoque (>= ${minStock}) e SEM vendas em ${period.label} para ${seller} — mostrando ${limited.length}:\n${lines.join("\n")}`,
        { period, totalCandidates: candidates.length, products: rows }
      );
    } catch (err) {
      return toErrorResult(err, "buscar_produtos_sem_vendas");
    }
  },
};

// ---- comparar_periodos ----

const compararSchema = {
  seller: z.string().describe("Nome interno do seller"),
  dias: z.number().int().positive().max(180).optional().describe("Tamanho de cada período em dias (default 30)"),
};

export const compararPeriodosTool: ToolDefinition<typeof compararSchema> = {
  name: "comparar_periodos",
  title: "Comparar períodos",
  description:
    "Compara as vendas do período atual (últimos N dias) com o período imediatamente anterior (mesma duração): faturamento, pedidos, unidades, ticket médio, visitas, taxa de conversão, variação percentual, produtos que mais cresceram, produtos que mais caíram e produtos que zeraram vendas. Ideal para 'compare as vendas dos últimos 30 dias com os 30 dias anteriores'.",
  inputSchema: compararSchema,
  handler: async ({ seller, dias }) => {
    try {
      const row = resolveSeller(seller);
      const current = lastNDays(dias ?? 30);
      const previous = precedingNDays(dias ?? 30);

      const [currentOrders, previousOrders] = await Promise.all([
        searchAllOrders(seller, row.ml_user_id!, { dateFrom: current.from, dateTo: current.to, maxOrders: 5000 }),
        searchAllOrders(seller, row.ml_user_id!, { dateFrom: previous.from, dateTo: previous.to, maxOrders: 5000 }),
      ]);

      const currentTotals = computeTotals(currentOrders);
      const previousTotals = computeTotals(previousOrders);
      const currentByItem = aggregateOrdersByItem(currentOrders);
      const previousByItem = aggregateOrdersByItem(previousOrders);
      const comparisons = compareItemAggregates(currentByItem, previousByItem);

      const allItemIds = [...new Set([...currentByItem.keys(), ...previousByItem.keys()])];
      const [visitsCurrent, visitsPrevious] = await Promise.all([
        getItemsVisits(seller, allItemIds, current.from, current.to),
        getItemsVisits(seller, allItemIds, previous.from, previous.to),
      ]);
      const totalVisitsCurrent = Object.values(visitsCurrent).reduce((a, b) => a + b, 0);
      const totalVisitsPrevious = Object.values(visitsPrevious).reduce((a, b) => a + b, 0);
      const conversionCurrent = totalVisitsCurrent > 0 ? (currentTotals.orders / totalVisitsCurrent) * 100 : null;
      const conversionPrevious = totalVisitsPrevious > 0 ? (previousTotals.orders / totalVisitsPrevious) * 100 : null;

      const grew = topGrowth(comparisons, 10);
      const fell = topDrops(comparisons, 10);
      const zeroed = comparisons.filter((c) => c.currentQty === 0 && c.previousQty > 0);

      const fmt = (n: number) => `R$ ${n.toFixed(2)}`;
      const pct = (n: number | null) => (n === null ? "n/d" : `${n >= 0 ? "+" : ""}${n.toFixed(1)}%`);

      const text = [
        `Comparação para ${seller}: ${current.label} vs ${previous.label}`,
        ``,
        `Faturamento: ${fmt(currentTotals.revenue)} vs ${fmt(previousTotals.revenue)} (${pct(pctChange(currentTotals.revenue, previousTotals.revenue))})`,
        `Pedidos: ${currentTotals.orders} vs ${previousTotals.orders} (${pct(pctChange(currentTotals.orders, previousTotals.orders))})`,
        `Unidades: ${currentTotals.units} vs ${previousTotals.units} (${pct(pctChange(currentTotals.units, previousTotals.units))})`,
        `Ticket médio: ${fmt(currentTotals.avgTicket)} vs ${fmt(previousTotals.avgTicket)} (${pct(pctChange(currentTotals.avgTicket, previousTotals.avgTicket))})`,
        `Visitas (itens vendidos em algum dos períodos): ${totalVisitsCurrent} vs ${totalVisitsPrevious}`,
        `Conversão aproximada: ${conversionCurrent?.toFixed(2) ?? "n/d"}% vs ${conversionPrevious?.toFixed(2) ?? "n/d"}%`,
        ``,
        `Produtos que mais cresceram (por faturamento):`,
        ...grew.map((g) => `  + ${g.itemId} ${g.title}: ${fmt(g.previousRevenue)} -> ${fmt(g.currentRevenue)} (${pct(g.revenueChangePct)})`),
        ``,
        `Produtos que mais caíram (por faturamento):`,
        ...fell.map((f) => `  - ${f.itemId} ${f.title}: ${fmt(f.previousRevenue)} -> ${fmt(f.currentRevenue)} (${pct(f.revenueChangePct)})`),
        ``,
        `Produtos que zeraram vendas (venderam no período anterior, nada no atual): ${zeroed.length}`,
        ...zeroed.slice(0, 15).map((z) => `  * ${z.itemId} ${z.title}`),
      ].join("\n");

      return ok(text, {
        current,
        previous,
        currentTotals,
        previousTotals,
        conversionCurrent,
        conversionPrevious,
        grew,
        fell,
        zeroed,
      });
    } catch (err) {
      return toErrorResult(err, "comparar_periodos");
    }
  },
};

// ---- analisar_queda_vendas ----

const quedaSchema = {
  seller: z.string().describe("Nome interno do seller"),
  dias: z.number().int().positive().max(180).optional().describe("Tamanho de cada período em dias (default 30)"),
  quedaMinimaPct: z
    .number()
    .min(0)
    .max(100)
    .optional()
    .describe("Só mostrar produtos com queda percentual de faturamento maior ou igual a este valor (default 20)"),
  limite: z.number().int().positive().max(200).optional().describe("Máximo de SKUs a retornar (default 30)"),
};

export const analisarQuedaVendasTool: ToolDefinition<typeof quedaSchema> = {
  name: "analisar_queda_vendas",
  title: "Analisar queda de vendas por SKU",
  description:
    "Identifica quais SKUs/anúncios tiveram maior queda de vendas (faturamento e unidades) comparando o período atual com o anterior, ordenados da maior para a menor queda. Ideal para 'analise quais SKUs tiveram maior queda de vendas'.",
  inputSchema: quedaSchema,
  handler: async ({ seller, dias, quedaMinimaPct, limite }) => {
    try {
      const row = resolveSeller(seller);
      const current = lastNDays(dias ?? 30);
      const previous = precedingNDays(dias ?? 30);
      const minDropPct = quedaMinimaPct ?? 20;
      const max = limite ?? 30;

      const [currentOrders, previousOrders] = await Promise.all([
        searchAllOrders(seller, row.ml_user_id!, { dateFrom: current.from, dateTo: current.to, maxOrders: 5000 }),
        searchAllOrders(seller, row.ml_user_id!, { dateFrom: previous.from, dateTo: previous.to, maxOrders: 5000 }),
      ]);

      const currentByItem = aggregateOrdersByItem(currentOrders);
      const previousByItem = aggregateOrdersByItem(previousOrders);
      const comparisons = compareItemAggregates(currentByItem, previousByItem).filter(
        (c) => c.previousRevenue > 0 && (c.revenueChangePct ?? 0) <= -minDropPct
      );

      comparisons.sort((a, b) => (a.revenueChangePct ?? 0) - (b.revenueChangePct ?? 0));
      const limited = comparisons.slice(0, max);

      const fmt = (n: number) => `R$ ${n.toFixed(2)}`;
      const lines = limited.map(
        (c) =>
          `- ${c.itemId} | ${c.title} | ${fmt(c.previousRevenue)} -> ${fmt(c.currentRevenue)} (${c.revenueChangePct?.toFixed(1)}%) | unidades: ${c.previousQty} -> ${c.currentQty}`
      );

      return ok(
        `${comparisons.length} SKU(s) com queda >= ${minDropPct}% de faturamento (${current.label} vs ${previous.label}) — mostrando ${limited.length}:\n${lines.join("\n")}`,
        { current, previous, drops: limited, totalMatching: comparisons.length }
      );
    } catch (err) {
      return toErrorResult(err, "analisar_queda_vendas");
    }
  },
};
