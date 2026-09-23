import { mlGet } from "./client.js";
import { env } from "../config/env.js";
import { getValidAccessToken } from "../auth/tokenManager.js";
import { MlApiError } from "./errors.js";

/**
 * Endpoints adicionados para deixar o Enginne no mesmo nível do conector
 * Qnix: pós-venda (reclamações), avaliações, catálogo, preço, qualidade,
 * promoções por item, Full, faturamento e visitas diárias.
 *
 * Todos são somente leitura. As respostas da ML são tipadas de forma
 * permissiva (`any`) porque vários desses recursos mudam de formato com
 * frequência — as tools extraem só os campos que usam e sempre devolvem o
 * JSON bruto em structuredContent para conferência.
 */

// ---- Pedidos e envios ----
export const getOrder = (seller: string, orderId: string) => mlGet<any>(seller, `/orders/${orderId}`);

export const getShipment = (seller: string, shipmentId: string | number) =>
  mlGet<any>(seller, `/shipments/${shipmentId}`, { headers: { "x-format-new": "true" } });

export const getShipmentCosts = (seller: string, shipmentId: string | number) =>
  mlGet<any>(seller, `/shipments/${shipmentId}/costs`);

// ---- Pós-venda: reclamações, mediações, devoluções ----
export function searchClaims(
  seller: string,
  params: { status?: string; type?: string; stage?: string; offset?: number; limit?: number }
) {
  return mlGet<any>(seller, "/post-purchase/v1/claims/search", {
    query: {
      status: params.status,
      type: params.type,
      stage: params.stage,
      offset: params.offset ?? 0,
      limit: params.limit ?? 30,
      sort: "last_updated:desc",
    },
  });
}

export const getClaim = (seller: string, claimId: string) => mlGet<any>(seller, `/post-purchase/v1/claims/${claimId}`);

export const getClaimReason = (seller: string, reasonId: string) =>
  mlGet<any>(seller, `/post-purchase/v1/claims/reasons/${reasonId}`);

export const getClaimReturns = (seller: string, claimId: string) =>
  mlGet<any>(seller, `/post-purchase/v2/claims/${claimId}/returns`);

// ---- Avaliações (opiniões) ----
export const getItemReviews = (seller: string, itemId: string, offset = 0, limit = 50) =>
  mlGet<any>(seller, `/reviews/item/${itemId}`, { query: { offset, limit } });

// ---- Perguntas ----
export const getQuestion = (seller: string, questionId: string) =>
  mlGet<any>(seller, `/questions/${questionId}`, { query: { api_version: 4 } });

export const getQuestionsResponseTime = (seller: string, userId: string) =>
  mlGet<any>(seller, `/users/${userId}/questions/response_time`);

// ---- Catálogo, preço e tipo de anúncio ----
export const getPriceToWin = (seller: string, itemId: string) =>
  mlGet<any>(seller, `/items/${itemId}/price_to_win`, { query: { siteId: itemId.slice(0, 3), version: "v2" } });

export const getCatalogEligibility = (seller: string, itemId: string) =>
  mlGet<any>(seller, `/items/${itemId}/catalog_listing_eligibility`);

export const getPriceSuggestion = (seller: string, itemId: string) =>
  mlGet<any>(seller, `/suggestions/items/${itemId}/details`);

export const getAvailableUpgrades = (seller: string, itemId: string) => mlGet<any>(seller, `/items/${itemId}/available_upgrades`);
export const getAvailableDowngrades = (seller: string, itemId: string) => mlGet<any>(seller, `/items/${itemId}/available_downgrades`);

export const getListingPrices = (seller: string, siteId: string, price: number, categoryId: string) =>
  mlGet<any>(seller, `/sites/${siteId}/listing_prices`, { query: { price, category_id: categoryId } });

export const getCatalogProductItems = (seller: string, productId: string) =>
  mlGet<any>(seller, `/products/${productId}/items`);

// ---- Qualidade da publicação ----
export const getItemPerformance = (seller: string, itemId: string) => mlGet<any>(seller, `/item/${itemId}/performance`);

// ---- Promoções de um item ----
export const getItemPromotions = (seller: string, itemId: string) =>
  mlGet<any>(seller, `/seller-promotions/items/${itemId}`, { query: { app_version: "v2" } });

// ---- Full (Fulfillment) ----
export const getFulfillmentStock = (seller: string, inventoryId: string) =>
  mlGet<any>(seller, `/inventories/${inventoryId}/stock/fulfillment`);

// ---- Visitas da conta por dia ----
export const getSellerVisitsTimeWindow = (seller: string, userId: string, days: number) =>
  mlGet<any>(seller, `/users/${userId}/items_visits/time_window`, { query: { last: days, unit: "day" } });

// ---- Faturamento (Mercado Livre) ----
export const getBillingPeriods = (seller: string, group: "ML" | "MP", limit = 12) =>
  mlGet<any>(seller, "/billing/integration/monthly/periods", {
    query: { group, document_type: "BILL", offset: 0, limit },
  });

export const getBillingSummary = (seller: string, periodKey: string, group: "ML" | "MP") =>
  mlGet<any>(seller, `/billing/integration/periods/key/${periodKey}/summary/details`, {
    query: { group, document_type: "BILL" },
  });

// ---- Imagens ----

/**
 * Sobe uma imagem (base64 ou data URL) para o repositório de fotos da ML e
 * devolve o ID da foto, que depois é usado em PUT /items/{id} { pictures }.
 */
export async function uploadPicture(sellerName: string, base64OrDataUrl: string, fileName = "foto.jpg"): Promise<{ id: string; variations?: unknown[] }> {
  const m = /^data:([^;]+);base64,(.*)$/s.exec(base64OrDataUrl);
  const mime = m?.[1] ?? (fileName.endsWith(".png") ? "image/png" : "image/jpeg");
  const bytes = Buffer.from(m?.[2] ?? base64OrDataUrl, "base64");
  const token = await getValidAccessToken(sellerName);
  const form = new FormData();
  form.append("file", new Blob([bytes], { type: mime }), fileName);
  const res = await fetch(`${env.ML_API_BASE_URL}/pictures/items/upload`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
  const body: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new MlApiError(res.status, body?.error, body?.message ?? `Erro ${res.status} ao subir imagem`, "/pictures/items/upload");
  return body;
}
