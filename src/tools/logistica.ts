import { z } from "zod";
import { resolveSeller } from "./resolveSeller.js";
import { ok, toErrorResult, type ToolDefinition } from "./types.js";
import {
  getShipment,
  getUserReputation,
  listPromotions,
  getPromotionItems,
  searchAllItemIds,
  getItemsMultiget,
} from "../mercadolivre/endpoints.js";

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

const itensPromoSchema = {
  seller: z.string().describe("Nome interno do seller"),
  promotionId: z.string().describe("ID da promoção, ex.: P-MLB18059016 ou LGH-MLB1000 (ver consultar_promocoes)"),
  promotionType: z
    .string()
    .describe("Tipo da promoção, ex.: DEAL, SMART, LIGHTNING, UNHEALTHY_STOCK (ver consultar_promocoes)"),
};

export const consultarItensPromocaoTool: ToolDefinition<typeof itensPromoSchema> = {
  name: "consultar_itens_promocao",
  title: "Consultar itens de uma promoção",
  description: "Lista os MLBs que estão participando de uma campanha promocional específica (candidatos e ativos).",
  inputSchema: itensPromoSchema,
  handler: async ({ seller, promotionId, promotionType }) => {
    try {
      resolveSeller(seller);
      const res = await getPromotionItems(seller, promotionId, promotionType);
      const lines = res.results.map(
        (i) => `- ${i.id} | status: ${i.status}${i.price ? ` | R$ ${i.price} (de R$ ${i.original_price})` : ""}`
      );
      return ok(`${res.results.length} item(ns) na promoção ${promotionId}:\n${lines.join("\n")}`, {
        items: res.results,
      });
    } catch (err) {
      return toErrorResult(err, "consultar_itens_promocao");
    }
  },
};

const foraPromocaoSchema = { seller: z.string().describe("Nome interno do seller") };

export const buscarAnunciosForaPromocaoTool: ToolDefinition<typeof foraPromocaoSchema> = {
  name: "buscar_anuncios_fora_promocao",
  title: "Buscar anúncios fora de promoção",
  description:
    "Lista os anúncios ATIVOS do seller que não estão participando de nenhuma campanha promocional no momento — cruza todas as campanhas de consultar_promocoes com o catálogo completo.",
  inputSchema: foraPromocaoSchema,
  handler: async ({ seller }) => {
    try {
      const row = resolveSeller(seller);
      const promos = await listPromotions(seller, row.ml_user_id!);

      const idsEmPromocao = new Set<string>();
      const falhas: string[] = [];
      for (const p of promos.results) {
        try {
          const items = await getPromotionItems(seller, p.id, p.type);
          for (const it of items.results) idsEmPromocao.add(it.id);
        } catch (err) {
          falhas.push(`${p.id} (${p.type}): ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      const allIds = await searchAllItemIds(seller, row.ml_user_id!, 2000);
      const items = await getItemsMultiget(seller, allIds);
      const ativos = items.filter((i) => i.status === "active");
      const foraDePromocao = ativos.filter((i) => !idsEmPromocao.has(i.id));

      const lines = foraDePromocao.map(
        (i) => `- ${i.id} | ${i.title} | R$ ${i.price} | vendidos: ${i.sold_quantity}`
      );

      return ok(
        `${foraDePromocao.length} de ${ativos.length} anúncios ativos de ${seller} NÃO estão em nenhuma promoção ativa` +
          `${falhas.length > 0 ? ` (obs: ${falhas.length} campanha(s) não puderam ser consultadas)` : ""}:\n${lines.join("\n")}`,
        {
          total_ativos: ativos.length,
          total_em_promocao: idsEmPromocao.size,
          fora_de_promocao: foraDePromocao,
          falhas_consulta: falhas,
        }
      );
    } catch (err) {
      return toErrorResult(err, "buscar_anuncios_fora_promocao");
    }
  },
};
