import { z } from "zod";
import { resolveSeller } from "./resolveSeller.js";
import { ok, toErrorResult, type ToolDefinition } from "./types.js";
import { getShipment, getUserReputation, listPromotions } from "../mercadolivre/endpoints.js";

const envioSchema = {
  seller: z.string().describe("Nome interno do seller"),
  shipmentId: z.string().describe("ID do envio (shipment_id), geralmente obtido via consultar_pedidos"),
};

export const consultarEnviosTool: ToolDefinition<typeof envioSchema> = {
  name: "consultar_envios",
  title: "Consultar envio",
  description: "Detalha o status de um envio específico (pending, shipped, delivered, not_delivered, etc.) e rastreio.",
  inputSchema: envioSchema,
  handler: async ({ seller, shipmentId }) => {
    try {
      resolveSeller(seller);
      const shipment = await getShipment(seller, shipmentId);
      return ok(
        `Envio ${shipment.id}: status ${shipment.status}${shipment.substatus ? ` (${shipment.substatus})` : ""}\n` +
          `Rastreio: ${shipment.tracking_number ?? "n/d"} | Criado em: ${shipment.date_created}`,
        { shipment }
      );
    } catch (err) {
      return toErrorResult(err, "consultar_envios");
    }
  },
};

const reputacaoSchema = { seller: z.string().describe("Nome interno do seller") };

export const consultarReputacaoTool: ToolDefinition<typeof reputacaoSchema> = {
  name: "consultar_reputacao",
  title: "Consultar reputação",
  description: "Retorna o nível de reputação do vendedor, status de power seller e métricas (reclamações, atraso, cancelamentos).",
  inputSchema: reputacaoSchema,
  handler: async ({ seller }) => {
    try {
      const row = resolveSeller(seller);
      const res = await getUserReputation(seller, row.ml_user_id!);
      const rep = res.seller_reputation;
      return ok(
        `Reputação de ${seller}: nível ${rep.level_id ?? "n/d"} | power seller: ${rep.power_seller_status ?? "não"}\n` +
          `Transações: ${rep.transactions.total} (${rep.transactions.completed} concluídas, ${rep.transactions.canceled} canceladas)\n` +
          `Avaliações: +${rep.transactions.ratings.positive} / neutras ${rep.transactions.ratings.neutral} / -${rep.transactions.ratings.negative}\n` +
          (rep.metrics
            ? `Métricas: reclamações ${((rep.metrics.claims?.rate ?? 0) * 100).toFixed(1)}%, atraso no envio ${(
                (rep.metrics.delayed_handling_time?.rate ?? 0) * 100
              ).toFixed(1)}%, cancelamentos ${((rep.metrics.cancellations?.rate ?? 0) * 100).toFixed(1)}%`
            : ""),
        { reputation: rep }
      );
    } catch (err) {
      return toErrorResult(err, "consultar_reputacao");
    }
  },
};

const promoSchema = { seller: z.string().describe("Nome interno do seller") };

export const consultarPromocoesTool: ToolDefinition<typeof promoSchema> = {
  name: "consultar_promocoes",
  title: "Consultar promoções",
  description: "Lista as campanhas/promoções (ofertas, descontos, cupons) ativas ou disponíveis para o seller.",
  inputSchema: promoSchema,
  handler: async ({ seller }) => {
    try {
      const row = resolveSeller(seller);
      const res = await listPromotions(seller, row.ml_user_id!);
      const lines = res.results.map((p) => `- ${p.id} | tipo: ${p.type} | status: ${p.status}`);
      return ok(`${res.results.length} promoção(ões) encontrada(s):\n${lines.join("\n")}`, { promotions: res.results });
    } catch (err) {
      return toErrorResult(err, "consultar_promocoes");
    }
  },
};
