import { mlGet } from "./client.js";
import { paginateScan, collect } from "./pagination.js";

/**
 * Wrappers tipados sobre os recursos públicos da API do Mercado Livre
 * (api.mercadolibre.com). Mantidos deliberadamente "finos": cada função
 * mapeia 1:1 para um endpoint documentado, sem lógica de negócio — a lógica
 * de negócio (comparações, agregações) mora em src/tools/.
 *
 * Referência: https://developers.mercadolivre.com.br/pt_br (API Docs)
 */

// ---- Users ----
export interface MlUser {
  id: number;
  nickname: string;
  registration_date: string;
  country_id: string;
  seller_reputation?: {
    level_id: string | null;
    power_seller_status: string | null;
    transactions: { completed: number; canceled: number; total: number };
  };
  status?: { site_status: string };
}

export const getMe = (sellerName: string) => mlGet<MlUser>(sellerName, "/users/me");
export const getUser = (sellerName: string, userId: string) => mlGet<MlUser>(sellerName, `/users/${userId}`);

// ---- Items (anúncios) ----
export interface MlItemSearchResult {
  results: string[]; // IDs (MLB...)
  paging: { total: number; offset: number; limit: number };
  scroll_id?: string;
}

export async function searchAllItemIds(sellerName: string, userId: string, maxItems = 5000): Promise<string[]> {
  const ids = await collect(
    paginateScan<string>({ sellerName, path: `/users/${userId}/items/search`, maxItems }),
    maxItems
  );
  return ids;
}

export interface MlItem {
  id: string;
  title: string;
  status: string; // active, paused, closed, under_review, etc.
  price: number;
  currency_id: string;
  available_quantity: number;
  sold_quantity: number;
  permalink: string;
  category_id: string;
  listing_type_id: string;
  health?: number;
  last_updated: string;
  date_created: string;
  shipping?: { free_shipping: boolean; logistic_type?: string };
  attributes?: Array<{ id: string; name: string; value_name: string | null }>;
}

/** GET /items?ids=MLB1,MLB2,... (multiget, até 20 por chamada). */
export async function getItemsMultiget(sellerName: string, itemIds: string[]): Promise<MlItem[]> {
  const chunks: string[][] = [];
  for (let i = 0; i < itemIds.length; i += 20) chunks.push(itemIds.slice(i, i + 20));

  const out: MlItem[] = [];
  for (const chunk of chunks) {
    const res = await mlGet<Array<{ code: number; body: MlItem }>>(sellerName, "/items", {
      query: { ids: chunk.join(",") },
    });
    for (const entry of res) {
      if (entry.code === 200) out.push(entry.body);
    }
  }
  return out;
}

export const getItem = (sellerName: string, itemId: string) => mlGet<MlItem>(sellerName, `/items/${itemId}`);

export interface MlItemDescription {
  plain_text: string;
}
export const getItemDescription = (sellerName: string, itemId: string) =>
  mlGet<MlItemDescription>(sellerName, `/items/${itemId}/description`);

// ---- Visitas ----
export interface MlItemVisitsResult {
  [itemId: string]: { total_visits?: number };
}

/** GET /items/visits?ids=... — visitas totais dos itens no período. */
export async function getItemsVisits(
  sellerName: string,
  itemIds: string[],
  dateFrom: string,
  dateTo: string
): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  const chunks: string[][] = [];
  for (let i = 0; i < itemIds.length; i += 20) chunks.push(itemIds.slice(i, i + 20));

  for (const chunk of chunks) {
    const res = await mlGet<Array<{ item_id: string; total_visits: number }>>(sellerName, "/items/visits", {
      query: { ids: chunk.join(","), date_from: dateFrom, date_to: dateTo },
    });
    for (const entry of res) out[entry.item_id] = entry.total_visits;
  }
  return out;
}

// ---- Orders (pedidos/vendas) ----
export interface MlOrder {
  id: number;
  date_created: string;
  date_closed: string | null;
  status: string; // paid, cancelled, confirmed, payment_required, etc.
  total_amount: number;
  currency_id: string;
  order_items: Array<{
    item: { id: string; title: string; seller_sku?: string };
    quantity: number;
    unit_price: number;
  }>;
  buyer?: { id: number; nickname: string };
  shipping?: { id: number };
}

export interface MlOrderSearchResult {
  results: MlOrder[];
  paging: { total: number; offset: number; limit: number };
}

export async function searchOrders(
  sellerName: string,
  userId: string,
  params: { dateFrom: string; dateTo: string; offset?: number; limit?: number }
): Promise<MlOrderSearchResult> {
  return mlGet<MlOrderSearchResult>(sellerName, "/orders/search", {
    query: {
      seller: userId,
      "order.date_created.from": params.dateFrom,
      "order.date_created.to": params.dateTo,
      offset: params.offset ?? 0,
      limit: params.limit ?? 50,
      sort: "date_desc",
    },
  });
}

export async function searchAllOrders(
  sellerName: string,
  userId: string,
  params: { dateFrom: string; dateTo: string; maxOrders?: number }
): Promise<MlOrder[]> {
  const maxOrders = params.maxOrders ?? 2000;
  const out: MlOrder[] = [];
  let offset = 0;
  const limit = 50;
  // /orders/search não suporta scan; respeita teto de offset da API (paginamos até 1000 por consulta)
  while (out.length < maxOrders) {
    const page = await searchOrders(sellerName, userId, { ...params, offset, limit });
    out.push(...page.results);
    if (page.results.length < limit || offset + limit >= 1000) break;
    offset += limit;
  }
  return out.slice(0, maxOrders);
}

// ---- Questions (perguntas) ----
export interface MlQuestion {
  id: number;
  item_id: string;
  status: string; // UNANSWERED, ANSWERED, BANNED, CLOSED_UNANSWERED
  text: string;
  date_created: string;
  answer?: { text: string; date_created: string } | null;
}

export interface MlQuestionSearchResult {
  questions: MlQuestion[];
  total: number;
}

export async function searchQuestions(
  sellerName: string,
  userId: string,
  params: { status?: string; offset?: number; limit?: number }
): Promise<MlQuestionSearchResult> {
  return mlGet<MlQuestionSearchResult>(sellerName, "/questions/search", {
    query: {
      seller_id: userId,
      status: params.status,
      offset: params.offset ?? 0,
      limit: params.limit ?? 50,
    },
  });
}

// ---- Shipments (envios) ----
export interface MlShipment {
  id: number;
  status: string; // pending, handling, ready_to_ship, shipped, delivered, not_delivered, cancelled
  substatus: string | null;
  tracking_number: string | null;
  date_created: string;
  logistic_type?: string;
}

export const getShipment = (sellerName: string, shipmentId: number | string) =>
  mlGet<MlShipment>(sellerName, `/shipments/${shipmentId}`);

// ---- Reputation ----
export interface MlReputation {
  level_id: string | null;
  power_seller_status: string | null;
  transactions: {
    total: number;
    completed: number;
    canceled: number;
    period: string;
    ratings: { positive: number; negative: number; neutral: number };
  };
  metrics?: {
    claims?: { rate: number; value: number };
    delayed_handling_time?: { rate: number; value: number };
    cancellations?: { rate: number; value: number };
  };
}

export const getUserReputation = (sellerName: string, userId: string) =>
  mlGet<{ seller_reputation: MlReputation }>(sellerName, `/users/${userId}`, {
    query: { attributes: "seller_reputation" },
  });

// ---- Promotions ----
export interface MlPromotion {
  id: string;
  type: string;
  status: string;
  start_date?: string;
  finish_date?: string;
}

export const listPromotions = (sellerName: string, userId: string) =>
  mlGet<{ results: MlPromotion[] }>(sellerName, `/seller-promotions/users/${userId}`, {
    query: { app_version: "v2" },
  });

// ---- Prices (histórico simplificado via item) ----
export const getItemPrice = (sellerName: string, itemId: string) => getItem(sellerName, itemId);
