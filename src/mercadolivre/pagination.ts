import { mlGet } from "./client.js";

interface ScrollSearchResponse<T> {
  scroll_id?: string;
  results: T[];
  paging?: { total: number; offset: number; limit: number };
}

/**
 * Pagina um endpoint de busca da ML usando offset/limit, respeitando o
 * teto de 1000 registros por offset que a API impõe em /items/search e
 * similares. Uso: `for await (const item of paginateOffset(...)) {...}`.
 *
 * Para contas GRANDES (5k-10k+ anúncios), preferir `paginateScan` quando o
 * endpoint suportar `search_type=scan` (evita o limite de offset 1000).
 */
export async function* paginateOffset<T>(params: {
  sellerName: string;
  path: string;
  query?: Record<string, string | number | boolean | undefined>;
  pageSize?: number;
  maxItems?: number;
}): AsyncGenerator<T, void, unknown> {
  const pageSize = params.pageSize ?? 50;
  let offset = 0;
  let total = Infinity;
  let yielded = 0;

  while (offset < total) {
    const page = await mlGet<ScrollSearchResponse<T>>(params.sellerName, params.path, {
      query: { ...params.query, offset, limit: pageSize },
    });
    total = Math.min(page.paging?.total ?? 0, 1000); // teto de offset da API
    for (const item of page.results) {
      yield item;
      yielded++;
      if (params.maxItems && yielded >= params.maxItems) return;
    }
    if (page.results.length === 0) break;
    offset += pageSize;
  }
}

/**
 * Pagina via scroll (`search_type=scan`), sem o teto de 1000 — recomendado
 * pela ML para contas com muitos anúncios. Necessário para
 * `/users/{id}/items/search` quando o total ultrapassa 1000 itens.
 */
export async function* paginateScan<T>(params: {
  sellerName: string;
  path: string;
  query?: Record<string, string | number | boolean | undefined>;
  pageSize?: number;
  maxItems?: number;
}): AsyncGenerator<T, void, unknown> {
  const pageSize = params.pageSize ?? 100;
  let scrollId: string | undefined;
  let yielded = 0;
  let firstPage = true;

  while (firstPage || scrollId) {
    firstPage = false;
    const page = await mlGet<ScrollSearchResponse<T>>(params.sellerName, params.path, {
      query: { ...params.query, search_type: "scan", scroll_id: scrollId, limit: pageSize },
    });
    if (page.results.length === 0) return;
    for (const item of page.results) {
      yield item;
      yielded++;
      if (params.maxItems && yielded >= params.maxItems) return;
    }
    scrollId = page.scroll_id;
    if (!scrollId) return;
  }
}

/** Coleta um async generator inteiro em array (uso quando o total é controlado, ex.: comparações). */
export async function collect<T>(gen: AsyncGenerator<T>, hardCap = 5000): Promise<T[]> {
  const out: T[] = [];
  for await (const item of gen) {
    out.push(item);
    if (out.length >= hardCap) break;
  }
  return out;
}
