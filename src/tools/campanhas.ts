import { z } from "zod";
import { resolveSeller } from "./resolveSeller.js";
import { ok, toErrorResult, type ToolDefinition } from "./types.js";
import { lastNDaysYmd } from "./dateUtils.js";
import { listAdvertisers, listCampaigns, getCampaign, type MlCampaign } from "../mercadolivre/advertisingEndpoints.js";

/**
 * Tools de leitura da Advertising API (Product Ads) — campanhas pagas de
 * anúncios, com valor investido e vendas atribuídas. Diferente de
 * `consultar_promocoes` (descontos/cupons, sem custo de mídia).
 */

class NoAdvertiserError extends Error {
  constructor(seller: string) {
    super(
      `A conta "${seller}" não tem um advertiser_id de Product Ads — provavelmente nunca configurou uma campanha de anúncios patrocinados no Mercado Livre. ` +
        `Confirme em "Publicidade" no painel do vendedor, ou use consultar_promocoes para ver descontos/cupons (isso é diferente de campanhas pagas).`
    );
    this.name = "NoAdvertiserError";
  }
}

async function resolveAdvertiserId(seller: string): Promise<number | string> {
  const advertisers = await listAdvertisers(seller, "PADS");
  if (advertisers.length === 0) throw new NoAdvertiserError(seller);
  // Uma conta quase sempre tem 1 advertiser por site; se houver mais de um, usamos o primeiro
  // e citamos os demais na mensagem para o usuário decidir se precisa de outro.
  return advertisers[0].advertiser_id;
}

function fmtMoney(n: number | undefined): string {
  return n === undefined ? "n/d" : `R$ ${n.toFixed(2)}`;
}

function fmtCampaignLine(c: MlCampaign): string {
  const m = c.metrics ?? {};
  return (
    `- ${c.id} | ${c.name} | status: ${c.status}` +
    (c.strategy ? ` | estratégia: ${c.strategy}` : "") +
    `\n    investido: ${fmtMoney(m.cost)} | vendas atribuídas: ${fmtMoney(m.total_amount)}` +
    ` (diretas: ${fmtMoney(m.direct_amount)}, indiretas: ${fmtMoney(m.indirect_amount)})` +
    `\n    cliques: ${m.clicks ?? "n/d"} | impressões: ${m.prints ?? "n/d"} | CTR: ${m.ctr !== undefined ? (m.ctr * 100).toFixed(2) + "%" : "n/d"}` +
    ` | ACOS: ${m.acos !== undefined ? m.acos.toFixed(1) + "%" : "n/d"} | ROAS: ${m.roas !== undefined ? m.roas.toFixed(2) : "n/d"}`
  );
}

const campanhasSchema = {
  seller: z.string().describe("Nome interno do seller (ver listar_contas)"),
  dias: z.number().int().positive().max(90).optional().describe("Janela em dias contados até agora (default 30). A Advertising API costuma limitar consultas a períodos de até ~90 dias por chamada."),
  status: z.enum(["active", "paused", "deleted", "todos"]).optional().describe('Filtrar por status da campanha. Default: "todos".'),
  limite: z.number().int().positive().max(200).optional().describe("Máximo de campanhas a retornar (default 50)"),
};

export const consultarCampanhasTool: ToolDefinition<typeof campanhasSchema> = {
  name: "consultar_campanhas",
  title: "Consultar campanhas de Ads (Product Ads)",
  description:
    "Lista as campanhas de Product Ads (anúncios patrocinados/publicidade paga) de um seller, com valor investido, vendas atribuídas (diretas e indiretas), cliques, impressões, CTR, ACOS e ROAS no período informado. Diferente de consultar_promocoes, que lista descontos/cupons sem custo de mídia. Requer que a conta já tenha usado Product Ads.",
  inputSchema: campanhasSchema,
  handler: async ({ seller, dias, status, limite }) => {
    try {
      resolveSeller(seller);
      const advertiserId = await resolveAdvertiserId(seller);
      const period = lastNDaysYmd(dias ?? 30);
      const max = limite ?? 50;

      const res = await listCampaigns(seller, advertiserId, {
        dateFrom: period.from,
        dateTo: period.to,
        status: status && status !== "todos" ? status : undefined,
        limit: max,
      });

      const campaigns = res.results ?? [];
      const totals = campaigns.reduce(
        (acc, c) => {
          const m = c.metrics ?? {};
          acc.cost += m.cost ?? 0;
          acc.totalAmount += m.total_amount ?? 0;
          acc.clicks += m.clicks ?? 0;
          acc.prints += m.prints ?? 0;
          return acc;
        },
        { cost: 0, totalAmount: 0, clicks: 0, prints: 0 }
      );
      const acosGeral = totals.totalAmount > 0 ? (totals.cost / totals.totalAmount) * 100 : undefined;

      const lines = campaigns.map(fmtCampaignLine);

      return ok(
        `${campaigns.length} campanha(s) de Product Ads para ${seller} (${period.label}):\n\n` +
          `TOTAIS: investido ${fmtMoney(totals.cost)} | vendas atribuídas ${fmtMoney(totals.totalAmount)}` +
          (acosGeral !== undefined ? ` | ACOS geral: ${acosGeral.toFixed(1)}%` : "") +
          ` | cliques: ${totals.clicks} | impressões: ${totals.prints}\n\n` +
          lines.join("\n\n"),
        { period, advertiserId, totals, campaigns }
      );
    } catch (err) {
      return toErrorResult(err, "consultar_campanhas");
    }
  },
};

const campanhaSchema = {
  seller: z.string().describe("Nome interno do seller"),
  campanhaId: z.string().describe("ID da campanha (ver consultar_campanhas)"),
  dias: z.number().int().positive().max(90).optional().describe("Janela em dias contados até agora (default 30)"),
};

export const consultarMetricasCampanhaTool: ToolDefinition<typeof campanhaSchema> = {
  name: "consultar_metricas_campanha",
  title: "Consultar métricas de uma campanha",
  description:
    "Detalha uma campanha de Product Ads específica: orçamento, estratégia, e métricas completas (investido, vendas atribuídas, cliques, impressões, CTR, CPC, ACOS, ROAS, CVR) no período informado.",
  inputSchema: campanhaSchema,
  handler: async ({ seller, campanhaId, dias }) => {
    try {
      resolveSeller(seller);
      const advertiserId = await resolveAdvertiserId(seller);
      const period = lastNDaysYmd(dias ?? 30);
      const campaign = await getCampaign(seller, advertiserId, campanhaId, { dateFrom: period.from, dateTo: period.to });
      return ok(`Campanha ${period.label}:\n${fmtCampaignLine(campaign)}`, { period, campaign });
    } catch (err) {
      return toErrorResult(err, "consultar_metricas_campanha");
    }
  },
};
