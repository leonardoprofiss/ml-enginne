import { z } from "zod";
import { resolveSeller } from "./resolveSeller.js";
import { ok, toErrorResult, type ToolDefinition } from "./types.js";
import { searchAllOrders } from "../mercadolivre/endpoints.js";
import { lastNDays } from "./dateUtils.js";

const periodoSchema = {
  seller: z.string().describe("Nome interno do seller"),
  dias: z.number().int().positive().max(365).optional().describe("Janela em dias contados até agora (default 30)"),
};

function summarizeOrders(orders: Awaited<ReturnType<typeof searchAllOrders>>) {
  const paid = orders.filter((o) => o.status === "paid" || o.status === "confirmed");
  const revenue = paid.reduce((sum, o) => sum + o.total_amount, 0);
  const units = paid.reduce((sum, o) => sum + o.order_items.reduce((u, oi) => u + oi.quantity, 0), 0);
  const avgTicket = paid.length > 0 ? revenue / paid.length : 0;
  return { totalOrders: orders.length, paidOrders: paid.length, revenue, units, avgTicket };
}

export const consultarVendasTool: ToolDefinition<typeof periodoSchema> = {
  name: "consultar_vendas",
  title: "Consultar vendas",
  description:
    "Resumo de vendas de um seller em uma janela de dias: faturamento, pedidos pagos, unidades vendidas e ticket médio. Base para 'analise as vendas dos últimos 30 dias'.",
  inputSchema: periodoSchema,
  handler: async ({ seller, dias }) => {
    try {
      const row = resolveSeller(seller);
      const period = lastNDays(dias ?? 30);
      const orders = await searchAllOrders(seller, row.ml_user_id!, { dateFrom: period.from, dateTo: period.to });
      const s = summarizeOrders(orders);
      return ok(
        `Vendas de ${seller} (${period.label}):\n` +
          `Faturamento: R$ ${s.revenue.toFixed(2)}\n` +
          `Pedidos pagos: ${s.paidOrders} (de ${s.totalOrders} pedidos totais)\n` +
          `Unidades vendidas: ${s.units}\n` +
          `Ticket médio: R$ ${s.avgTicket.toFixed(2)}`,
        { period, summary: s }
      );
    } catch (err) {
      return toErrorResult(err, "consultar_vendas");
    }
  },
};

const pedidosSchema = {
  ...periodoSchema,
  status: z
    .enum(["paid", "confirmed", "cancelled", "payment_required", "todos"])
    .optional()
    .describe('Filtrar por status do pedido. Default: "todos".'),
  limite: z.number().int().positive().max(500).optional().describe("Máximo de pedidos a listar (default 50)"),
};

export const consultarPedidosTool: ToolDefinition<typeof pedidosSchema> = {
  name: "consultar_pedidos",
  title: "Consultar pedidos",
  description: "Lista pedidos individuais de um seller em uma janela de dias, com itens, quantidade e valores.",
  inputSchema: pedidosSchema,
  handler: async ({ seller, dias, status, limite }) => {
    try {
      const row = resolveSeller(seller);
      const period = lastNDays(dias ?? 30);
      const max = limite ?? 50;
      const orders = await searchAllOrders(seller, row.ml_user_id!, {
        dateFrom: period.from,
        dateTo: period.to,
        maxOrders: 2000,
      });
      const filtered = status && status !== "todos" ? orders.filter((o) => o.status === status) : orders;
      const page = filtered.slice(0, max);
      const lines = page.map(
        (o) =>
          `- #${o.id} | ${o.date_created} | status: ${o.status} | R$ ${o.total_amount} | itens: ${o.order_items
            .map((oi) => `${oi.quantity}x ${oi.item.title}`)
            .join(", ")}`
      );
      return ok(
        `${filtered.length} pedido(s) em ${period.label} para ${seller}${status ? ` (status=${status})` : ""} — mostrando ${page.length}:\n${lines.join("\n")}`,
        { period, total: filtered.length, orders: page }
      );
    } catch (err) {
      return toErrorResult(err, "consultar_pedidos");
    }
  },
};
