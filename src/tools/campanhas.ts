import { z } from "zod";
import { resolveSeller } from "./resolveSeller.js";
import { ok, toErrorResult, type ToolDefinition } from "./types.js";
import { lastNDaysYmd } from "./dateUtils.js";
import {
  listAdvertisers,
  listCampaigns,
  getCampaign,
  listAdGroupsByAdvertiser,
  getAdGroup,
  listAdGroupItems,
  findAdGroupsByItems,
  type MlCampaign,
  type MlAdGroup,
  type MlAdItem,
} from "../mercadolivre/advertisingEndpoints.js";

/**
 * Tools de leitura da Advertising API (Product Ads) — campanhas pagas de
 * anúncios, com valor investido e vendas atribuídas. Diferente de
 * `consultar_promocoes` (descontos/cupons, sem custo de mídia).
 *
 * Desde 27/05/2026 o Mercado Livre reorganizou Product Ads em torno de "Ad
 * Groups" (por catálogo, família de variantes, ou item individual) dentro
 * de cada campanha — ver o comentário no topo de
 * `../mercadolivre/advertisingEndpoints.ts` para o histórico completo dessa
 * migração e por que as tools antigas paravam de funcionar.
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

interface ResolvedAdvertiser {
  advertiserId: number | string;
  siteId: string;
}

async function resolveAdvertiser(seller: string): Promise<ResolvedAdvertiser> {
  const advertisers = await listAdvertisers(seller, "PADS");
  if (advertisers.length === 0) throw new NoAdvertiserError(seller);
  // Uma conta quase sempre tem 1 advertiser por site; se houver mais de um, usamos o primeiro.
  return { advertiserId: advertisers[0].advertiser_id, siteId: advertisers[0].site_id };
}

function fmtMoney(n: number | undefined): string {
  return n === undefined ? "n/d" : `R$ ${n.toFixed(2)}`;
}

function fmtPct(n: number | undefined): string {
  return n === undefined ? "n/d" : `${n.toFixed(1)}%`;
}

function fmtCampaignLine(c: MlCampaign): string {
  const m = c.metrics ?? {};
  const target = c.roas_target !== undefined ? `ROAS alvo: ${c.roas_target.toFixed(1)}x` : c.acos_target !== undefined ? `ACOS alvo: ${c.acos_target.toFixed(1)}%` : "";
  return (
    `- ${c.id} | ${c.name} | status: ${c.status}` +
    (c.strategy ? ` | estratégia: ${c.strategy}` : "") +
    (target ? ` | ${target}` : "") +
    `\n    investido: ${fmtMoney(m.cost)} | vendas atribuídas: ${fmtMoney(m.total_amount)}` +
    ` (diretas: ${fmtMoney(m.direct_amount)}, indiretas: ${fmtMoney(m.indirect_amount)})` +
    `\n    cliques: ${m.clicks ?? "n/d"} | impressões: ${m.prints ?? "n/d"} | CTR: ${m.ctr !== undefined ? (m.ctr * 100).toFixed(2) + "%" : "n/d"}` +
    ` | ACOS: ${fmtPct(m.acos)} | ROAS: ${m.roas !== undefined ? m.roas.toFixed(2) : "n/d"} | SOV: ${fmtPct(m.sov)}`
  );
}

function fmtCompetitividade(c: MlCampaign): string {
  const m = c.metrics ?? {};
  if (m.impression_share === undefined && m.acos_benchmark === undefined) {
    return "Sem dados de competitividade para essa campanha/período.";
  }
  return (
    `Impressões ganhas: ${fmtPct(m.impression_share)} (das disputas em que a campanha podia participar)\n` +
    `Impressões perdidas por orçamento: ${fmtPct(m.lost_impression_share_by_budget)} — se alto, orçamento diário está baixo\n` +
    `Impressões perdidas por ranking: ${fmtPct(m.lost_impression_share_by_ad_rank)} — se alto, considere subir o ACOS/ROAS alvo ou melhorar a qualidade dos anúncios\n` +
    `ACOS de referência (benchmark de anúncios bem posicionados): ${fmtPct(m.acos_benchmark)}` +
    (m.top_impression_share !== undefined ? `\nImpressões no topo da busca: ${fmtPct(m.top_impression_share)}` : "")
  );
}

function fmtAdGroupLine(g: MlAdGroup): string {
  const m = g.metrics ?? {};
  return (
    `- ad_group ${g.id} | ${g.title ?? g.ad_group_external_id ?? "(sem título)"} | tipo: ${g.ad_group_type ?? "n/d"} | status: ${g.status} | campanha: ${g.campaign_id}` +
    `\n    investido: ${fmtMoney(m.cost)} | vendas atribuídas: ${fmtMoney(m.total_amount)} | ACOS: ${fmtPct(m.acos)} | ROAS: ${m.roas !== undefined ? m.roas.toFixed(2) : "n/d"}` +
    ` | TACOS: ${fmtPct(m.tacos)} | SOV: ${fmtPct(m.sov)}` +
    `\n    cliques: ${m.clicks ?? "n/d"} | impressões: ${m.prints ?? "n/d"}`
  );
}

function fmtItemLine(it: MlAdItem): string {
  const m = it.metrics ?? {};
  return (
    `- ${it.item_id} | ${it.title} | status: ${it.status} | preço: ${fmtMoney(it.price)}` +
    (it.buy_box_winner !== undefined ? ` | buy box: ${it.buy_box_winner ? "sim" : "não"}` : "") +
    (it.current_level ? ` | reputação: ${it.current_level}` : "") +
    (it.logistic_type ? ` | logística: ${it.logistic_type}` : "") +
    `\n    investido: ${fmtMoney(m.cost)} | vendas atribuídas: ${fmtMoney(m.total_amount)} | ACOS: ${fmtPct(m.acos)} | TACOS: ${fmtPct(m.tacos)} | ROAS: ${m.roas !== undefined ? m.roas.toFixed(2) : "n/d"}` +
    (it.family_id ? `\n    family_id: ${it.family_id} (${it.family_name ?? "n/d"})` : "") +
    (it.user_product_id ? ` | user_product_id: ${it.user_product_id}` : "")
  );
}

// ---- consultar_campanhas ----

const campanhasSchema = {
  seller: z.string().describe("Nome interno do seller (ver listar_contas)"),
  dias: z.number().int().positive().max(90).optional().describe("Janela em dias contados até agora (default 30). A Advertising API limita consultas a até 90 dias por chamada."),
  status: z.enum(["active", "paused", "todos"]).optional().describe('Filtrar por status da campanha. Default: "todos".'),
  limite: z.number().int().positive().max(200).optional().describe("Máximo de campanhas a retornar (default 50)"),
};

export const consultarCampanhasTool: ToolDefinition<typeof campanhasSchema> = {
  name: "consultar_campanhas",
  title: "Consultar campanhas de Ads (Product Ads)",
  description:
    "Lista as campanhas de Product Ads (anúncios patrocinados/publicidade paga) de um seller, com valor investido, vendas atribuídas (diretas e indiretas), cliques, impressões, CTR, ACOS, ROAS e SOV no período informado. Diferente de consultar_promocoes, que lista descontos/cupons sem custo de mídia. Para métricas por Ad Group ou por item (SKU) dentro de uma campanha, use consultar_ad_groups / consultar_itens_ad_group. Requer que a conta já tenha usado Product Ads.",
  inputSchema: campanhasSchema,
  handler: async ({ seller, dias, status, limite }) => {
    try {
      resolveSeller(seller);
      const { advertiserId, siteId } = await resolveAdvertiser(seller);
      const period = lastNDaysYmd(dias ?? 30);
      const max = limite ?? 50;

      const res = await listCampaigns(seller, siteId, advertiserId, {
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
        { period, advertiserId, siteId, totals, campaigns }
      );
    } catch (err) {
      return toErrorResult(err, "consultar_campanhas");
    }
  },
};

// ---- consultar_metricas_campanha ----

const campanhaSchema = {
  seller: z.string().describe("Nome interno do seller"),
  campanhaId: z.string().describe("ID da campanha (ver consultar_campanhas)"),
  dias: z.number().int().positive().max(90).optional().describe("Janela em dias contados até agora (default 30)"),
};

export const consultarMetricasCampanhaTool: ToolDefinition<typeof campanhaSchema> = {
  name: "consultar_metricas_campanha",
  title: "Consultar métricas de uma campanha",
  description:
    "Detalha uma campanha de Product Ads específica: orçamento, estratégia, meta de ROAS/ACOS, e métricas completas (investido, vendas atribuídas, cliques, impressões, CTR, CPC, ACOS, ROAS, CVR, SOV) no período informado. Já inclui as métricas de competitividade (impression share, perdas por orçamento/ranking, ACOS de referência) — para uma leitura focada só nelas, use consultar_competitividade_campanha.",
  inputSchema: campanhaSchema,
  handler: async ({ seller, campanhaId, dias }) => {
    try {
      resolveSeller(seller);
      const { siteId } = await resolveAdvertiser(seller);
      const period = lastNDaysYmd(dias ?? 30);
      const campaign = await getCampaign(seller, siteId, campanhaId, { dateFrom: period.from, dateTo: period.to });
      return ok(`Campanha ${period.label}:\n${fmtCampaignLine(campaign)}\n\nCompetitividade:\n${fmtCompetitividade(campaign)}`, { period, campaign });
    } catch (err) {
      return toErrorResult(err, "consultar_metricas_campanha");
    }
  },
};

// ---- consultar_competitividade_campanha ----

export const consultarCompetitividadeCampanhaTool: ToolDefinition<typeof campanhaSchema> = {
  name: "consultar_competitividade_campanha",
  title: "Consultar competitividade de uma campanha (leilão)",
  description:
    "Mostra só as métricas de competitividade/leilão de uma campanha: % de impressões ganhas, perdidas por orçamento insuficiente, perdidas por ranking baixo, e o ACOS de referência de anúncios bem posicionados. Ajuda a diagnosticar se o gargalo de uma campanha é orçamento ou qualidade/ACOS. Essas métricas só existem no detalhe de campanha (não aparecem em consultar_campanhas).",
  inputSchema: campanhaSchema,
  handler: async ({ seller, campanhaId, dias }) => {
    try {
      resolveSeller(seller);
      const { siteId } = await resolveAdvertiser(seller);
      const period = lastNDaysYmd(dias ?? 30);
      const campaign = await getCampaign(seller, siteId, campanhaId, { dateFrom: period.from, dateTo: period.to });
      return ok(`Competitividade da campanha ${campaign.name} (${campanhaId}), ${period.label}:\n\n${fmtCompetitividade(campaign)}`, { period, campaign });
    } catch (err) {
      return toErrorResult(err, "consultar_competitividade_campanha");
    }
  },
};

// ---- consultar_ad_groups ----

const adGroupsSchema = {
  seller: z.string().describe("Nome interno do seller"),
  campanhaId: z.string().optional().describe("Se informado, lista só os Ad Groups dessa campanha. Se omitido, lista todos os Ad Groups do seller."),
  status: z.string().optional().describe('Filtrar por status (ex.: "active"). Default: todos.'),
  dias: z.number().int().positive().max(90).optional().describe("Janela em dias contados até agora (default 30)"),
  limite: z.number().int().positive().max(500).optional().describe("Máximo de Ad Groups a retornar (default 50)"),
};

export const consultarAdGroupsTool: ToolDefinition<typeof adGroupsSchema> = {
  name: "consultar_ad_groups",
  title: "Consultar Ad Groups de Product Ads",
  description:
    "Lista os Ad Groups (agrupadores de anúncio por catálogo, família de variantes ou item — o nível abaixo de campanha desde a reestruturação de maio/2026 do Mercado Livre) com métricas: investido, vendas atribuídas, ACOS, ROAS, TACOS, SOV. Use campanhaId para focar numa campanha. Para ver os itens/SKUs dentro de um Ad Group específico, use consultar_itens_ad_group.",
  inputSchema: adGroupsSchema,
  handler: async ({ seller, campanhaId, status, dias, limite }) => {
    try {
      resolveSeller(seller);
      const { advertiserId, siteId } = await resolveAdvertiser(seller);
      const period = lastNDaysYmd(dias ?? 30);

      const res = await listAdGroupsByAdvertiser(seller, siteId, advertiserId, {
        dateFrom: period.from,
        dateTo: period.to,
        limit: limite ?? 50,
        filters: { campaignId: campanhaId, status },
      });

      const groups = res.results ?? [];
      const totals = groups.reduce(
        (acc, g) => {
          const m = g.metrics ?? {};
          acc.cost += m.cost ?? 0;
          acc.totalAmount += m.total_amount ?? 0;
          return acc;
        },
        { cost: 0, totalAmount: 0 }
      );

      return ok(
        `${groups.length} Ad Group(s) para ${seller}${campanhaId ? ` (campanha ${campanhaId})` : ""} (${period.label}):\n\n` +
          `TOTAIS: investido ${fmtMoney(totals.cost)} | vendas atribuídas ${fmtMoney(totals.totalAmount)}\n\n` +
          groups.map(fmtAdGroupLine).join("\n\n"),
        { period, advertiserId, siteId, totals, adGroups: groups }
      );
    } catch (err) {
      return toErrorResult(err, "consultar_ad_groups");
    }
  },
};

// ---- consultar_itens_ad_group ----

const itensAdGroupSchema = {
  seller: z.string().describe("Nome interno do seller"),
  adGroupId: z.string().describe("ID do Ad Group (ver consultar_ad_groups ou buscar_ad_group_por_sku)"),
  dias: z.number().int().positive().max(90).optional().describe("Janela em dias contados até agora (default 30)"),
};

export const consultarItensAdGroupTool: ToolDefinition<typeof itensAdGroupSchema> = {
  name: "consultar_itens_ad_group",
  title: "Consultar itens (SKUs) de um Ad Group",
  description:
    "Lista os itens/anúncios individuais dentro de um Ad Group, com preço, se ganha o Buy Box, tipo de logística, reputação, qualidade de imagem, e métricas por item (investido, vendas atribuídas, ACOS, TACOS, ROAS). É o nível mais granular da Advertising API — útil para ver quais variantes de um produto estão performando bem ou mal dentro do mesmo agrupamento.",
  inputSchema: itensAdGroupSchema,
  handler: async ({ seller, adGroupId, dias }) => {
    try {
      resolveSeller(seller);
      const { siteId } = await resolveAdvertiser(seller);
      const period = lastNDaysYmd(dias ?? 30);
      const res = await listAdGroupItems(seller, siteId, adGroupId, { dateFrom: period.from, dateTo: period.to });
      const items = res.results ?? [];
      return ok(
        `${items.length} item(ns) no Ad Group ${adGroupId} (${period.label}):\n\n` + items.map(fmtItemLine).join("\n\n"),
        { period, items }
      );
    } catch (err) {
      return toErrorResult(err, "consultar_itens_ad_group");
    }
  },
};

// ---- buscar_ad_group_por_sku ----

const buscarAdGroupSchema = {
  seller: z.string().describe("Nome interno do seller"),
  skus: z.array(z.string()).min(1).max(50).describe("Lista de item_id/SKU do Mercado Livre (ex.: MLB123456789) a localizar"),
};

export const buscarAdGroupPorSkuTool: ToolDefinition<typeof buscarAdGroupSchema> = {
  name: "buscar_ad_group_por_sku",
  title: "Localizar Ad Group/campanha de um ou mais SKUs",
  description:
    "Dado um ou mais item_id (SKU do Mercado Livre), retorna em qual Ad Group e campanha cada um está publicado (se estiver em alguma campanha de Product Ads no momento). Útil para descobrir onde um produto específico está sendo anunciado antes de consultar seus itens/métricas com consultar_itens_ad_group.",
  inputSchema: buscarAdGroupSchema,
  handler: async ({ seller, skus }) => {
    try {
      resolveSeller(seller);
      const { advertiserId, siteId } = await resolveAdvertiser(seller);
      const groups = await findAdGroupsByItems(seller, siteId, advertiserId, skus);
      if (groups.length === 0) {
        return ok(`Nenhum dos SKUs informados está em campanha de Product Ads no momento.`, { skus, groups: [] });
      }
      const lines = groups.map((g) => `- SKU ${g.ad_group_external_id ?? "n/d"} → ad_group ${g.id} | campanha ${g.campaign_id} | status: ${g.status} | tipo: ${g.ad_group_type ?? "n/d"}`);
      return ok(`${groups.length} de ${skus.length} SKU(s) encontrados em campanhas:\n\n${lines.join("\n")}`, { skus, groups });
    } catch (err) {
      return toErrorResult(err, "buscar_ad_group_por_sku");
    }
  },
};
