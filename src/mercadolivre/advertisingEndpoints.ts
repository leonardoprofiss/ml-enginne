import { mlGet } from "./client.js";

/**
 * Wrappers sobre a API de Publicidade (Advertising API / Product Ads) do
 * Mercado Livre — usada para campanhas pagas (patrocinados), diferente de
 * `/seller-promotions` (descontos/cupons, já coberto em `listPromotions`).
 *
 * ATENÇÃO (2026-09-04): a partir de 27/05/2026 o Mercado Livre desativou
 * PERMANENTEMENTE os endpoints "legados" de Product Ads (confirmado na
 * documentação oficial: developers.mercadolivre.com.br/pt_br/product-ads-para-catalogo-e-user-products-leitura,
 * seção "Endpoints descontinuados"). Isso incluía o endpoint que este
 * arquivo usava até então:
 *
 *     GET /advertising/advertisers/$ADVERTISER_ID/product_ads/campaigns
 *
 * — por isso `consultar_campanhas` vinha retornando erro em produção mesmo
 * com advertiser_id, escopo OAuth e header Api-Version corretos: a rota
 * simplesmente não existe mais, para ninguém, desde aquela data. Não era
 * bug de configuração nem do nosso lado nem (apesar do suporte ter
 * insistido o contrário) puramente do lado deles — era migração de API já
 * documentada.
 *
 * O que mudou estruturalmente: anúncios agora são agrupados em "Ad Groups"
 * (por CATALOG, FAMILY ou ITEM) dentro de cada campanha — os endpoints de
 * "ads" (anúncio individual) foram removidos, e no lugar deles a API expõe
 * o nível de Ad Group (com as mesmas métricas + TACOS) e, dentro de cada Ad
 * Group, o nível de item (com preço, buy box, logística, reputação etc.).
 *
 * Diferenças importantes em relação ao resto de `endpoints.ts`:
 *  - Base de rota própria: `/advertising/...` (mesmo host `api.mercadolibre.com`).
 *  - Exige o header `Api-Version` em toda chamada (1 para advertisers, 2 para
 *    campanhas/ad groups/itens).
 *  - A maioria das rotas de campanha/ad group agora exige `$ADVERTISER_SITE_ID`
 *    (ex.: "MLB") no path, além ou no lugar do `advertiser_id` — cada
 *    endpoint tem seu próprio formato de path, não são todos iguais (ver
 *    comentário em cada função abaixo). Isso foi confirmado lendo a
 *    documentação oficial diretamente, não é suposição.
 *  - Não trabalha com o `ml_user_id` do seller diretamente — primeiro é
 *    preciso descobrir o `advertiser_id` E o `site_id` (uma conta quase
 *    sempre tem 1 advertiser por site/país) via `listAdvertisers`.
 *  - A conta do seller precisa ter o produto de Publicidade habilitado no
 *    Mercado Livre — se nunca usou Ads, `listAdvertisers` retorna lista
 *    vazia, não erro.
 *
 * Se `consultar_campanhas`/`consultar_ad_groups` voltarem a dar 404/400
 * inesperado no futuro, o primeiro passo é reconferir essa página de
 * documentação antes de assumir bug no código — a Advertising API muda com
 * mais frequência que o resto da API do ML.
 */

const ADVERTISER_API_VERSION = "1";
const ADS_API_VERSION = "2"; // campanhas, ad groups e itens

function adsHeaders(version: string, extra?: Record<string, string>): Record<string, string> {
  return { "Api-Version": version, ...extra };
}

/** Serializa `filters` como os parâmetros `filters[chave]=valor` que a Advertising API espera. */
function filterParams(filters?: Record<string, string | number | undefined>): Record<string, string | number | undefined> {
  if (!filters) return {};
  const out: Record<string, string | number | undefined> = {};
  for (const [key, value] of Object.entries(filters)) {
    if (value !== undefined) out[`filters[${key}]`] = value;
  }
  return out;
}

// ---- Advertisers ----

export interface MlAdvertiser {
  advertiser_id: number;
  advertiser_name?: string;
  account_name?: string;
  /** ID do site/país (ex.: "MLB") — necessário em quase todas as chamadas de campanha/ad group. */
  site_id: string;
}

export type MlAdsProduct = "PADS" | "DISPLAY" | "BADS";

/**
 * Descobre o(s) `advertiser_id`/`site_id` do seller para um produto de Ads.
 * `PADS` = Product Ads (o que interessa para "campanhas de anúncios de produto").
 * Lista vazia é normal para sellers que nunca configuraram Ads — não é erro.
 * Único endpoint que NÃO mudou na migração de maio/2026.
 */
export async function listAdvertisers(sellerName: string, productId: MlAdsProduct = "PADS"): Promise<MlAdvertiser[]> {
  const res = await mlGet<{ advertisers: MlAdvertiser[] }>(sellerName, "/advertising/advertisers", {
    query: { product_id: productId },
    headers: adsHeaders(ADVERTISER_API_VERSION),
  });
  return res.advertisers ?? [];
}

// ---- Campaigns ----

/** Métricas disponíveis na listagem/busca de campanhas (nível campanha). */
export const CAMPAIGN_METRICS = [
  "clicks",
  "prints", // impressões
  "ctr",
  "cost", // valor investido
  "cpc",
  "acos",
  "cvr",
  "roas",
  "sov", // % de vendas por publicidade sobre vendas totais
  "direct_amount",
  "indirect_amount",
  "total_amount",
  "direct_units_quantity",
  "indirect_units_quantity",
  "units_quantity",
  "direct_items_quantity",
  "indirect_items_quantity",
  "advertising_items_quantity",
  "organic_units_quantity",
  "organic_units_amount",
  "organic_items_quantity",
] as const;

/** Métricas de "competitividade" (leilão) — só disponíveis no detalhe de UMA campanha, não na listagem. */
export const CAMPAIGN_COMPETITIVIDADE_METRICS = [
  "impression_share",
  "top_impression_share",
  "lost_impression_share_by_budget",
  "lost_impression_share_by_ad_rank",
  "acos_benchmark",
] as const;

export interface MlCampaignMetrics {
  clicks?: number;
  prints?: number;
  ctr?: number;
  cost?: number;
  cpc?: number;
  acos?: number;
  cvr?: number;
  roas?: number;
  sov?: number;
  direct_amount?: number;
  indirect_amount?: number;
  total_amount?: number;
  direct_units_quantity?: number;
  indirect_units_quantity?: number;
  units_quantity?: number;
  direct_items_quantity?: number;
  indirect_items_quantity?: number;
  advertising_items_quantity?: number;
  organic_units_quantity?: number;
  organic_units_amount?: number;
  organic_items_quantity?: number;
  // Só vêm quando pedidas no detalhe de uma campanha específica:
  impression_share?: number;
  top_impression_share?: number;
  lost_impression_share_by_budget?: number;
  lost_impression_share_by_ad_rank?: number;
  acos_benchmark?: number;
  [key: string]: number | undefined;
}

export interface MlCampaign {
  id: number | string;
  name: string;
  status: string; // active, paused
  budget?: number;
  daily_budget?: number;
  currency_id?: string;
  strategy?: string; // PROFITABILITY, INCREASE, VISIBILITY
  /** Alvo em ROAS — métrica padrão desde jan/2026 (substitui acos_target, que deixa de ser retornado a partir de 30/03/2026). */
  roas_target?: number;
  /** @deprecated substituído por roas_target — pode não vir mais na resposta. */
  acos_target?: number;
  date_created?: string;
  last_updated?: string;
  channel?: string; // marketplace
  metrics?: MlCampaignMetrics;
}

export interface MlCampaignListResult {
  paging: { total: number; offset: number; limit: number };
  results: MlCampaign[];
}

/**
 * Lista/busca campanhas de Product Ads de um advertiser, com métricas
 * agregadas no período informado. `dateFrom`/`dateTo` no formato YYYY-MM-DD.
 *
 * Path confirmado na doc oficial (2026-09-04): note que o `site_id` vem
 * ANTES de "advertisers" — diferente do path antigo (desativado) que não
 * tinha site_id nenhum. "/search" no final agora é obrigatório.
 */
export async function listCampaigns(
  sellerName: string,
  siteId: string,
  advertiserId: number | string,
  params: {
    dateFrom: string;
    dateTo: string;
    status?: "active" | "paused";
    campaignIds?: string;
    offset?: number;
    limit?: number;
  }
): Promise<MlCampaignListResult> {
  return mlGet<MlCampaignListResult>(sellerName, `/advertising/${siteId}/advertisers/${advertiserId}/product_ads/campaigns/search`, {
    query: {
      date_from: params.dateFrom,
      date_to: params.dateTo,
      metrics: CAMPAIGN_METRICS.join(","),
      metrics_summary: false, // não confiar nele: já vimos em produção somar a conta inteira, ignorando filtro — somamos na mão em campanhas.ts
      offset: params.offset ?? 0,
      limit: params.limit ?? 50,
      ...filterParams({ status: params.status, campaign_ids: params.campaignIds }),
    },
    headers: adsHeaders(ADS_API_VERSION),
  });
}

/**
 * Detalhe + métricas (incluindo competitividade) de uma campanha específica.
 *
 * Path confirmado na doc oficial: aqui NÃO entra "advertisers/{advertiserId}"
 * — é só site_id direto para o id da campanha. Path diferente do de listagem
 * de propósito, não é inconsistência nossa.
 */
export async function getCampaign(
  sellerName: string,
  siteId: string,
  campaignId: number | string,
  params: { dateFrom: string; dateTo: string }
): Promise<MlCampaign> {
  return mlGet<MlCampaign>(sellerName, `/advertising/${siteId}/product_ads/campaigns/${campaignId}`, {
    query: {
      date_from: params.dateFrom,
      date_to: params.dateTo,
      metrics: [...CAMPAIGN_METRICS, ...CAMPAIGN_COMPETITIVIDADE_METRICS].join(","),
    },
    headers: adsHeaders(ADS_API_VERSION),
  });
}

// ---- Ad Groups ----

export type MlAdGroupType = "CATALOG" | "FAMILY" | "ITEM";

export const AD_GROUP_METRICS = [
  "clicks",
  "prints",
  "cost",
  "cpc",
  "ctr",
  "direct_amount",
  "indirect_amount",
  "total_amount",
  "direct_units_quantity",
  "indirect_units_quantity",
  "units_quantity",
  "direct_items_quantity",
  "indirect_items_quantity",
  "advertising_items_quantity",
  "organic_units_quantity",
  "organic_units_amount",
  "organic_items_quantity",
  "acos",
  "sov",
  "roas",
  "cvr",
  "tacos", // só existe a partir do nível de Ad Group pra baixo, não em campanha
] as const;

export interface MlAdGroupMetrics {
  clicks?: number;
  prints?: number;
  cost?: number;
  cpc?: number;
  ctr?: number;
  direct_amount?: number;
  indirect_amount?: number;
  total_amount?: number;
  direct_units_quantity?: number;
  indirect_units_quantity?: number;
  units_quantity?: number;
  direct_items_quantity?: number;
  indirect_items_quantity?: number;
  advertising_items_quantity?: number;
  organic_units_quantity?: number;
  organic_units_amount?: number;
  organic_items_quantity?: number;
  acos?: number;
  sov?: number;
  roas?: number;
  cvr?: number;
  tacos?: number;
  [key: string]: number | undefined;
}

export interface MlAdGroup {
  id: number; // este é o ad_group_id usado no resto das chamadas
  ad_group_external_id?: string; // parent_id (catálogo), family_id (user product) ou item_id (item tradicional)
  ad_group_type?: MlAdGroupType;
  status: string;
  campaign_id: number | string;
  advertiser_id?: number;
  title?: string;
  domain_id?: string;
  thumbnail?: string;
  date_created?: string;
  metrics?: MlAdGroupMetrics;
}

export interface MlAdGroupSearchResult {
  paging: { total: number; offset: number; limit: number };
  results: MlAdGroup[];
  metrics_summary?: MlAdGroupMetrics; // cuidado: ver nota sobre metrics_summary em listCampaigns
}

/**
 * Localiza o(s) `ad_group_id` a partir de um ou mais `item_id` (SKU do
 * Mercado Livre, ex. "MLB123456789"). Não precisa de período — é uma busca
 * de identidade, não de métricas.
 */
export async function findAdGroupsByItems(
  sellerName: string,
  siteId: string,
  advertiserId: number | string,
  itemIds: string[]
): Promise<MlAdGroup[]> {
  const res = await mlGet<MlAdGroupSearchResult>(sellerName, `/advertising/${siteId}/advertisers/${advertiserId}/product_ads/ad_groups/search`, {
    query: filterParams({ item_ids: itemIds.join(",") }),
    headers: adsHeaders(ADS_API_VERSION),
  });
  return res.results ?? [];
}

/**
 * Lista/busca Ad Groups de um advertiser, com métricas, no período
 * informado — o equivalente, no novo modelo, a "todas as campanhas com
 * métricas", só que num nível mais granular (por catálogo/família/item).
 * Aceita filtro por campanha (`filters.campaignId`) para restringir a uma
 * campanha só.
 */
export async function listAdGroupsByAdvertiser(
  sellerName: string,
  siteId: string,
  advertiserId: number | string,
  params: {
    dateFrom: string;
    dateTo: string;
    limit?: number;
    offset?: number;
    filters?: { campaignId?: string; status?: string; q?: string };
  }
): Promise<MlAdGroupSearchResult> {
  return mlGet<MlAdGroupSearchResult>(sellerName, `/advertising/${siteId}/advertisers/${advertiserId}/product_ads/ad_groups/search`, {
    query: {
      date_from: params.dateFrom,
      date_to: params.dateTo,
      limit: params.limit ?? 50,
      offset: params.offset ?? 0,
      metrics: AD_GROUP_METRICS.join(",").toUpperCase(),
      metrics_summary: false, // mesma ressalva de listCampaigns — não confiar, somar na mão
      ...filterParams({
        campaigns: params.filters?.campaignId,
        statuses: params.filters?.status,
        q: params.filters?.q,
      }),
    },
    headers: adsHeaders(ADS_API_VERSION),
  });
}

/** Detalhe + métricas de UM Ad Group específico. */
export async function getAdGroup(
  sellerName: string,
  siteId: string,
  adGroupId: number | string,
  params: { dateFrom: string; dateTo: string }
): Promise<MlAdGroup> {
  return mlGet<MlAdGroup>(sellerName, `/advertising/${siteId}/product_ads/ad_groups/${adGroupId}`, {
    query: {
      date_from: params.dateFrom,
      date_to: params.dateTo,
      metrics: AD_GROUP_METRICS.join(","),
    },
    headers: adsHeaders(ADS_API_VERSION),
  });
}

// ---- Itens (anúncios individuais dentro de um Ad Group) ----

export interface MlAdItem {
  item_id: string;
  campaign_id: number | string;
  ad_group_id: number;
  price?: number;
  title: string;
  status: string;
  has_discount?: boolean;
  catalog_listing?: boolean;
  logistic_type?: string;
  listing_type_id?: string;
  domain_id?: string;
  buy_box_winner?: boolean;
  channel?: string;
  condition?: string;
  current_level?: string; // reputação
  deferred_stock?: boolean;
  thumbnail?: string;
  permalink?: string;
  image_quality?: string;
  family_id?: number | string;
  family_name?: string;
  user_product_id?: string;
  user_product_name?: string;
  metrics?: MlAdGroupMetrics;
}

export interface MlAdItemListResult {
  paging: { total: number; offset: number; limit: number };
  results: MlAdItem[];
}

/** Lista os itens (anúncios) que pertencem a um Ad Group, com métricas por item. */
export async function listAdGroupItems(
  sellerName: string,
  siteId: string,
  adGroupId: number | string,
  params: { dateFrom: string; dateTo: string }
): Promise<MlAdItemListResult> {
  return mlGet<MlAdItemListResult>(sellerName, `/advertising/${siteId}/product_ads/ad_groups/${adGroupId}/ads`, {
    query: {
      date_from: params.dateFrom,
      date_to: params.dateTo,
      metrics: AD_GROUP_METRICS.join(","),
    },
    headers: adsHeaders(ADS_API_VERSION),
  });
}
