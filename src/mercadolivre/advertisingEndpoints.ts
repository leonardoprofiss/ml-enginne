import { mlGet } from "./client.js";

/**
 * Wrappers sobre a API de Publicidade (Advertising API / Product Ads) do
 * Mercado Livre — usada para campanhas pagas (patrocinados), diferente de
 * `/seller-promotions` (descontos/cupons, já coberto em `listPromotions`).
 *
 * Diferenças importantes em relação ao resto de `endpoints.ts`:
 *  - Base de rota própria: `/advertising/...` (mesmo host `api.mercadolibre.com`).
 *  - Exige o header `Api-Version` em toda chamada.
 *  - Não trabalha com o `ml_user_id` do seller diretamente — primeiro é
 *    preciso descobrir o `advertiser_id` (uma conta pode ter mais de um,
 *    raro, mas o normal é 1 por site/país) via `listAdvertisers`.
 *  - A conta do seller precisa ter o produto de Publicidade habilitado no
 *    Mercado Livre (ter rodado ou estar apta a rodar Product Ads) — se
 *    nunca usou Ads, `listAdvertisers` retorna uma lista vazia, não um erro.
 *
 * ATENÇÃO: os paths/parâmetros abaixo foram reconstruídos a partir da
 * documentação pública (developers.mercadolivre.com.br/pt_br/product-ads-leitura
 * e equivalente em inglês) em 2026-09. A Advertising API muda com mais
 * frequência que o resto da API do ML — se `consultar_campanhas` começar a
 * retornar 404/400 inesperado, o primeiro passo é reconferir esses paths na
 * documentação atual antes de assumir bug no código.
 */

const ADVERTISING_API_VERSION = "1";

function adsHeaders(extra?: Record<string, string>): Record<string, string> {
  return { "Api-Version": ADVERTISING_API_VERSION, ...extra };
}

// ---- Advertisers ----

export interface MlAdvertiser {
  advertiser_id: number;
  advertiser_name?: string;
  account_name?: string;
  site_id: string;
}

export type MlAdsProduct = "PADS" | "DISPLAY" | "BADS";

/**
 * Descobre o(s) `advertiser_id` do seller para um produto de Ads.
 * `PADS` = Product Ads (o que interessa para "campanhas de anúncios de produto").
 * Lista vazia é normal para sellers que nunca configuraram Ads — não é erro.
 */
export async function listAdvertisers(sellerName: string, productId: MlAdsProduct = "PADS"): Promise<MlAdvertiser[]> {
  const res = await mlGet<{ advertisers: MlAdvertiser[] }>(sellerName, "/advertising/advertisers", {
    query: { product_id: productId },
    headers: adsHeaders(),
  });
  return res.advertisers ?? [];
}

// ---- Campaigns ----

export const CAMPAIGN_METRICS = [
  "cost", // valor investido
  "clicks",
  "prints", // impressões
  "ctr",
  "cpc",
  "acos",
  "roas",
  "cvr",
  "direct_amount", // vendas atribuídas diretas (R$)
  "indirect_amount", // vendas atribuídas indiretas/assistidas (R$)
  "total_amount", // direct + indirect
  "direct_items_quantity",
  "indirect_items_quantity",
  "units_quantity",
  "organic_units_quantity",
] as const;

export interface MlCampaignMetrics {
  cost?: number;
  clicks?: number;
  prints?: number;
  ctr?: number;
  cpc?: number;
  acos?: number;
  roas?: number;
  cvr?: number;
  direct_amount?: number;
  indirect_amount?: number;
  total_amount?: number;
  direct_items_quantity?: number;
  indirect_items_quantity?: number;
  units_quantity?: number;
  organic_units_quantity?: number;
  [key: string]: number | undefined;
}

export interface MlCampaign {
  id: number | string;
  name: string;
  status: string; // active, paused, deleted
  budget?: number;
  currency_id?: string;
  strategy?: string; // PROFITABILITY, INCREASE, VISIBILITY
  acos_target?: number;
  date_created?: string;
  last_updated?: string;
  channel?: string; // marketplace, mshops
  metrics?: MlCampaignMetrics;
}

export interface MlCampaignListResult {
  paging: { total: number; offset: number; limit: number };
  results: MlCampaign[];
}

/**
 * Lista campanhas de Product Ads de um advertiser, com métricas agregadas
 * no período informado. `dateFrom`/`dateTo` no formato YYYY-MM-DD.
 */
export async function listCampaigns(
  sellerName: string,
  advertiserId: number | string,
  params: {
    dateFrom: string;
    dateTo: string;
    status?: "active" | "paused" | "deleted";
    offset?: number;
    limit?: number;
  }
): Promise<MlCampaignListResult> {
  // NOTA (2026-09-03): testado em produção contra um advertiser_id real e válido —
  // o path SEM "/search" retorna 404 mesmo para advertiser existente (não é "sem
  // campanhas", é rota errada). Corrigido para "/search", que é o formato usado
  // por integrações de terceiros que já têm isso funcionando. Se voltar a dar
  // 404, o próximo suspeito é method/params, não mais este path.
  return mlGet<MlCampaignListResult>(sellerName, `/advertising/advertisers/${advertiserId}/product_ads/campaigns/search`, {
    query: {
      date_from: params.dateFrom,
      date_to: params.dateTo,
      metrics: CAMPAIGN_METRICS.join(","),
      metrics_summary: true,
      "filters[status]": params.status,
      offset: params.offset ?? 0,
      limit: params.limit ?? 50,
    },
    headers: adsHeaders(),
  });
}

/** Detalhe + métricas de uma campanha específica. */
export async function getCampaign(
  sellerName: string,
  advertiserId: number | string,
  campaignId: number | string,
  params: { dateFrom: string; dateTo: string }
): Promise<MlCampaign> {
  return mlGet<MlCampaign>(
    sellerName,
    `/advertising/advertisers/${advertiserId}/product_ads/campaigns/${campaignId}`,
    {
      query: { date_from: params.dateFrom, date_to: params.dateTo, metrics: CAMPAIGN_METRICS.join(",") },
      headers: adsHeaders(),
    }
  );
}
