import { z } from "zod";
import { resolveSeller } from "./resolveSeller.js";
import { ok, toErrorResult, type ToolDefinition } from "./types.js";
import { searchMarketplace, getItem, type MlSearchResultItem } from "../mercadolivre/endpoints.js";

/**
 * Pesquisa de mercado — usa a busca pública do Mercado Livre
 * (`/sites/{site}/search`, a mesma da caixa de busca do site) pra ver o que
 * a concorrência está cobrando por um termo/categoria, sem depender de
 * Product Ads estar habilitado na conta. Diferente de consultar_preco, que
 * é sobre um anúncio nosso específico.
 */

function fmtMoney(n: number | undefined | null, currency = "R$"): string {
  return n === undefined || n === null ? "n/d" : `${currency === "BRL" ? "R$" : currency} ${n.toFixed(2)}`;
}

function median(values: number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function fmtResultLine(it: MlSearchResultItem): string {
  return (
    `- ${it.title} | ${fmtMoney(it.price, it.currency_id)}` +
    (it.original_price ? ` (de ${fmtMoney(it.original_price, it.currency_id)})` : "") +
    ` | vendedor: ${it.seller.nickname ?? it.seller.id}` +
    ` | vendidos: ${it.sold_quantity}` +
    (it.shipping?.free_shipping ? " | frete grátis" : "") +
    (it.official_store_id ? " | loja oficial" : "") +
    `\n    ${it.permalink}`
  );
}

const pesquisaSchema = {
  seller: z.string().describe("Nome interno do seller — usado só para autenticar a busca, o resultado não é específico dessa conta (ver listar_contas)"),
  termo: z.string().min(1).describe('Termo de busca, igual ao que se digitaria na busca do Mercado Livre (ex.: "vitamina c 1g 30 comprimidos")'),
  categoria: z.string().optional().describe("ID de categoria do Mercado Livre para restringir a busca (opcional, ex.: MLB1246 para Saúde)"),
  ordenar: z.enum(["relevancia", "menor_preco", "maior_preco"]).optional().describe("Ordenação dos resultados. Default: relevância (a mesma ordem que aparece na busca do site)."),
  condicao: z.enum(["novo", "usado"]).optional().describe("Filtrar por condição do produto. Default: todos."),
  limite: z.number().int().positive().max(50).optional().describe("Máximo de resultados a retornar (default 20, máximo 50 por chamada)"),
  site: z.string().optional().describe('Código do site do Mercado Livre (default "MLB" = Brasil). Outros: MLA=Argentina, MLM=México, MCO=Colômbia, MLC=Chile.'),
};

export const pesquisarMercadoTool: ToolDefinition<typeof pesquisaSchema> = {
  name: "pesquisar_mercado",
  title: "Pesquisar preços de concorrentes no Mercado Livre",
  description:
    "Pesquisa o Mercado Livre (a mesma busca pública do site) por um termo ou categoria e retorna os anúncios encontrados com preço, vendedor, quantidade vendida e se tem frete grátis — útil para benchmarking de preço/concorrência antes de definir o preço ou o ACOS/ROAS alvo de uma campanha. Não precisa que a conta tenha Product Ads habilitado. Para comparar um produto NOSSO especificamente contra a busca do mesmo termo, primeiro pegue o título/preço dele com consultar_anuncio.",
  inputSchema: pesquisaSchema,
  handler: async ({ seller, termo, categoria, ordenar, condicao, limite, site }) => {
    try {
      resolveSeller(seller);
      const siteId = site ?? "MLB";
      const sortMap = { relevancia: "relevance", menor_preco: "price_asc", maior_preco: "price_desc" } as const;
      const conditionMap = { novo: "new", usado: "used" } as const;

      const res = await searchMarketplace(seller, siteId, {
        q: termo,
        categoryId: categoria,
        limit: limite ?? 20,
        sort: ordenar ? sortMap[ordenar] : undefined,
        condition: condicao ? conditionMap[condicao] : undefined,
      });

      const results = res.results ?? [];
      const prices = results.map((r) => r.price).filter((p) => typeof p === "number");
      const min = prices.length ? Math.min(...prices) : undefined;
      const max = prices.length ? Math.max(...prices) : undefined;
      const avg = prices.length ? prices.reduce((a, b) => a + b, 0) / prices.length : undefined;
      const med = median(prices);
      const currency = results[0]?.currency_id ?? "BRL";

      return ok(
        `${results.length} de ${res.paging?.total ?? results.length} resultado(s) para "${termo}" (site ${siteId}):\n\n` +
          `FAIXA DE PREÇO: mínimo ${fmtMoney(min, currency)} | máximo ${fmtMoney(max, currency)} | médio ${fmtMoney(avg, currency)} | mediana ${fmtMoney(med, currency)}\n\n` +
          results.map(fmtResultLine).join("\n\n"),
        { siteId, termo, stats: { min, max, avg, median: med }, results }
      );
    } catch (err) {
      return toErrorResult(err, "pesquisar_mercado");
    }
  },
};

// ---- comparar_concorrencia ----

const compararSchema = {
  seller: z.string().describe("Nome interno do seller"),
  mlb: z.string().describe("ID do anúncio NOSSO a comparar (ex.: MLB1234567890)"),
  termo: z.string().optional().describe("Termo de busca para achar a concorrência (default: o título do nosso próprio anúncio)"),
  limite: z.number().int().positive().max(50).optional().describe("Máximo de concorrentes a considerar (default 20)"),
};

export const compararConcorrenciaTool: ToolDefinition<typeof compararSchema> = {
  name: "comparar_concorrencia",
  title: "Comparar anúncio próprio com a concorrência",
  description:
    "Pega um anúncio NOSSO, pesquisa o mesmo termo (ou o termo informado) no Mercado Livre, e já compara nosso preço direto contra os concorrentes encontrados: quantos estão mais baratos, diferença percentual contra a média/mediana. Combina consultar_anuncio + pesquisar_mercado num passo só.",
  inputSchema: compararSchema,
  handler: async ({ seller, mlb, termo, limite }) => {
    try {
      resolveSeller(seller);
      const our = await getItem(seller, mlb);
      const termoBusca = termo ?? our.title;
      const siteId = mlb.match(/^[A-Z]{2,4}/)?.[0] ?? "MLB";

      const res = await searchMarketplace(seller, siteId, { q: termoBusca, limit: limite ?? 20 });
      const concorrentes = (res.results ?? []).filter((r) => r.id !== mlb);

      if (concorrentes.length === 0) {
        return ok(
          `Nenhum concorrente encontrado para "${termoBusca}" (além do nosso próprio anúncio, se apareceu). Nosso anúncio: ${our.title} — R$ ${our.price.toFixed(2)}.`,
          { our, termoBusca, concorrentes: [] }
        );
      }

      const precos = concorrentes.map((c) => c.price);
      const min = Math.min(...precos);
      const max = Math.max(...precos);
      const avg = precos.reduce((a, b) => a + b, 0) / precos.length;
      const sorted = [...precos].sort((a, b) => a - b);
      const mid = Math.floor(sorted.length / 2);
      const med = sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;

      const maisBaratos = precos.filter((p) => p < our.price).length;
      const diffMedia = ((our.price - avg) / avg) * 100;
      const diffMediana = ((our.price - med) / med) * 100;
      const posicao = maisBaratos === 0 ? "o mais barato" : `mais caro que ${maisBaratos} de ${concorrentes.length}`;

      return ok(
        `Nosso anúncio: ${our.title} — R$ ${our.price.toFixed(2)} (${mlb})\n` +
          `Concorrência para "${termoBusca}" (${concorrentes.length} resultado(s)): mínimo R$ ${min.toFixed(2)} | máximo R$ ${max.toFixed(2)} | médio R$ ${avg.toFixed(2)} | mediana R$ ${med.toFixed(2)}\n\n` +
          `Estamos ${posicao} entre os concorrentes. ${diffMedia >= 0 ? "Acima" : "Abaixo"} da média em ${Math.abs(diffMedia).toFixed(1)}%, ` +
          `${diffMediana >= 0 ? "acima" : "abaixo"} da mediana em ${Math.abs(diffMediana).toFixed(1)}%.`,
        { our, termoBusca, stats: { min, max, avg, median: med, maisBaratos, totalConcorrentes: concorrentes.length, diffMedia, diffMediana }, concorrentes }
      );
    } catch (err) {
      return toErrorResult(err, "comparar_concorrencia");
    }
  },
};
