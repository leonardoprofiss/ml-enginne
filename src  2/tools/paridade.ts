import { z } from "zod";
import { resolveSeller } from "./resolveSeller.js";
import { ok, errorResult, toErrorResult, type ToolDefinition } from "./types.js";
import { lastNDays } from "./dateUtils.js";
import { getItem, getItemsMultiget, getItemsVisits, searchAllItemIds, searchAllOrders, type MlOrder } from "../mercadolivre/endpoints.js";
import * as ex from "../mercadolivre/extraEndpoints.js";

/**
 * Tools adicionadas em set/2026 para deixar o Enginne no mesmo padrão do
 * conector Qnix: pedidos e custos, vendas por dia/anúncio, cancelamentos,
 * reclamações, avaliações, perguntas, catálogo, preço, qualidade,
 * promoções por item, Full, visitas diárias, faturamento e um diagnóstico
 * completo de anúncio. Todas são SOMENTE LEITURA.
 */

const brl = (v: number | null | undefined) =>
  v === null || v === undefined || Number.isNaN(v) ? "n/d" : `R$ ${Number(v).toFixed(2).replace(".", ",")}`;
const sellerArg = z.string().describe("Nome interno do seller (ver listar_contas)");
const diasArg = (def: number, max = 90) =>
  z.number().int().positive().max(max).optional().describe(`Janela em dias (default ${def})`);
const PAGOS = new Set(["paid", "confirmed", "partially_refunded"]);

/** Executa em lotes pequenos para não estourar rate limit. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

async function safe<T>(p: Promise<T>): Promise<T | { erro: string }> {
  try {
    return await p;
  } catch (err) {
    return { erro: err instanceof Error ? err.message : String(err) };
  }
}
const isErr = (x: unknown): x is { erro: string } => typeof x === "object" && x !== null && "erro" in x;

function ymdBr(iso: string) {
  return iso.slice(0, 10);
}

// =========================== PEDIDOS ===========================

const pedidoSchema = { seller: sellerArg, pedidoId: z.string().describe("ID do pedido (order_id)") };
export const consultarPedidoTool: ToolDefinition<typeof pedidoSchema> = {
  name: "consultar_pedido",
  title: "Consultar pedido",
  description: "Um pedido completo: itens, valores, comissão, pagamentos, status, comprador e o envio (status, rastreio e custo do frete).",
  inputSchema: pedidoSchema,
  handler: async ({ seller, pedidoId }) => {
    try {
      resolveSeller(seller);
      const order = await ex.getOrder(seller, pedidoId);
      const shipId = order.shipping?.id;
      const [ship, costs] = shipId ? await Promise.all([safe(ex.getShipment(seller, shipId)), safe(ex.getShipmentCosts(seller, shipId))]) : [null, null];
      const itens = (order.order_items ?? []).map(
        (oi: any) => `- ${oi.item?.id} ${oi.item?.title} | ${oi.quantity} x ${brl(oi.unit_price)} | comissão ${brl((oi.sale_fee ?? 0) * oi.quantity)}`
      );
      const shipTxt =
        ship && !isErr(ship)
          ? `Envio ${shipId}: ${ship.status}${ship.substatus ? `/${ship.substatus}` : ""} | logística ${ship.logistic?.type ?? ship.logistic_type ?? "n/d"}${ship.tracking_number ? ` | rastreio ${ship.tracking_number}` : ""}`
          : "Envio: sem dados";
      const costTxt = costs && !isErr(costs) ? ` | frete pago pelo vendedor ${brl(costs.senders?.[0]?.cost)}` : "";
      return ok(
        `Pedido ${order.id} — ${order.status} em ${order.date_created}\nTotal ${brl(order.total_amount)} | pago ${brl(order.paid_amount)}\n${itens.join("\n")}\n${shipTxt}${costTxt}`,
        { order, shipment: ship, costs }
      );
    } catch (err) {
      return toErrorResult(err, "consultar_pedido");
    }
  },
};

const custosSchema = {
  seller: sellerArg,
  dias: diasArg(30),
  incluirFrete: z.boolean().optional().describe("Busca o custo de frete de cada envio (mais lento). Default true até 200 pedidos."),
};
export const custosPedidosTool: ToolDefinition<typeof custosSchema> = {
  name: "custos_pedidos",
  title: "Custos por pedido",
  description: "Comissão (tarifa de venda) e frete pago pelo vendedor em cada pedido pago do período, com totais e % sobre a receita. Base para margem por pedido.",
  inputSchema: custosSchema,
  handler: async ({ seller, dias, incluirFrete }) => {
    try {
      const row = resolveSeller(seller);
      const period = lastNDays(dias ?? 30);
      const orders = (await searchAllOrders(seller, row.ml_user_id!, { dateFrom: period.from, dateTo: period.to, maxOrders: 1000 })).filter((o) =>
        PAGOS.has(o.status)
      );
      const doFrete = (incluirFrete ?? true) && orders.length <= 200;
      const linhas = await mapLimit(orders, 4, async (o: MlOrder) => {
        const comissao = o.order_items.reduce((a, oi) => a + (oi.sale_fee ?? 0) * oi.quantity, 0);
        let frete: number | null = null;
        if (doFrete && o.shipping?.id) {
          const c = await safe(ex.getShipmentCosts(seller, o.shipping.id));
          if (!isErr(c)) frete = Number(c.senders?.[0]?.cost ?? 0);
        }
        return { pedido: o.id, data: o.date_created, receita: o.total_amount, comissao, frete };
      });
      const receita = linhas.reduce((a, l) => a + l.receita, 0);
      const comissao = linhas.reduce((a, l) => a + l.comissao, 0);
      const frete = linhas.reduce((a, l) => a + (l.frete ?? 0), 0);
      const pct = (v: number) => (receita ? ((v / receita) * 100).toFixed(1).replace(".", ",") + "%" : "n/d");
      return ok(
        `${linhas.length} pedido(s) pago(s) em ${period.label}\nReceita ${brl(receita)} | Comissão ${brl(comissao)} (${pct(comissao)})` +
          (doFrete ? ` | Frete pago pelo vendedor ${brl(frete)} (${pct(frete)})` : " | Frete não calculado (mais de 200 pedidos ou incluirFrete=false)"),
        { periodo: period, totais: { receita, comissao, frete: doFrete ? frete : null }, pedidos: linhas }
      );
    } catch (err) {
      return toErrorResult(err, "custos_pedidos");
    }
  },
};

const vendasDiariasSchema = { seller: sellerArg, dias: diasArg(30) };
export const vendasDiariasTool: ToolDefinition<typeof vendasDiariasSchema> = {
  name: "vendas_diarias",
  title: "Vendas por dia",
  description: "Pedidos pagos, unidades, receita, comissão e ticket médio por dia, mais pedidos cancelados por dia.",
  inputSchema: vendasDiariasSchema,
  handler: async ({ seller, dias }) => {
    try {
      const row = resolveSeller(seller);
      const period = lastNDays(dias ?? 30);
      const orders = await searchAllOrders(seller, row.ml_user_id!, { dateFrom: period.from, dateTo: period.to, maxOrders: 1000 });
      const byDay = new Map<string, { pedidos: number; unidades: number; receita: number; comissao: number; cancelados: number }>();
      for (const o of orders) {
        const d = ymdBr(o.date_created);
        const r = byDay.get(d) ?? { pedidos: 0, unidades: 0, receita: 0, comissao: 0, cancelados: 0 };
        if (o.status === "cancelled") r.cancelados++;
        else if (PAGOS.has(o.status)) {
          r.pedidos++;
          r.receita += o.total_amount;
          for (const oi of o.order_items) {
            r.unidades += oi.quantity;
            r.comissao += (oi.sale_fee ?? 0) * oi.quantity;
          }
        }
        byDay.set(d, r);
      }
      const dias_ = [...byDay.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([data, r]) => ({ data, ...r, ticket: r.pedidos ? r.receita / r.pedidos : 0 }));
      const lines = dias_.map((d) => `${d.data}: ${d.pedidos} pedidos | ${d.unidades} un | ${brl(d.receita)} | ticket ${brl(d.ticket)} | cancelados ${d.cancelados}`);
      return ok(`Vendas por dia — ${period.label}:\n${lines.join("\n")}`, { periodo: period, dias: dias_ });
    } catch (err) {
      return toErrorResult(err, "vendas_diarias");
    }
  },
};

const vendasItemSchema = { seller: sellerArg, dias: diasArg(30), limite: z.number().int().positive().max(200).optional().describe("Quantos anúncios mostrar (default 30)") };
export const vendasPorAnuncioTool: ToolDefinition<typeof vendasItemSchema> = {
  name: "vendas_por_anuncio",
  title: "Ranking de vendas por anúncio",
  description: "Ranking de anúncios por unidades vendidas no período (pedidos pagos), com receita, pedidos, preço médio e comissão.",
  inputSchema: vendasItemSchema,
  handler: async ({ seller, dias, limite }) => {
    try {
      const row = resolveSeller(seller);
      const period = lastNDays(dias ?? 30);
      const orders = (await searchAllOrders(seller, row.ml_user_id!, { dateFrom: period.from, dateTo: period.to, maxOrders: 1000 })).filter((o) =>
        PAGOS.has(o.status)
      );
      const map = new Map<string, { mlb: string; titulo: string; sku?: string; unidades: number; receita: number; pedidos: number; comissao: number }>();
      for (const o of orders)
        for (const oi of o.order_items) {
          const r = map.get(oi.item.id) ?? { mlb: oi.item.id, titulo: oi.item.title, sku: oi.item.seller_sku, unidades: 0, receita: 0, pedidos: 0, comissao: 0 };
          r.unidades += oi.quantity;
          r.receita += oi.unit_price * oi.quantity;
          r.pedidos++;
          r.comissao += (oi.sale_fee ?? 0) * oi.quantity;
          map.set(oi.item.id, r);
        }
      const rank = [...map.values()].sort((a, b) => b.unidades - a.unidades).slice(0, limite ?? 30);
      const lines = rank.map((r, i) => `${i + 1}. ${r.mlb}${r.sku ? ` (${r.sku})` : ""} ${r.titulo} | ${r.unidades} un | ${brl(r.receita)} | ${r.pedidos} pedidos`);
      return ok(`Top anúncios — ${period.label}:\n${lines.join("\n")}`, { periodo: period, ranking: rank });
    } catch (err) {
      return toErrorResult(err, "vendas_por_anuncio");
    }
  },
};

export const cancelamentosTool: ToolDefinition<typeof vendasDiariasSchema> = {
  name: "cancelamentos",
  title: "Cancelamentos",
  description: "Pedidos cancelados no período por dia, com quem pediu o cancelamento (comprador, vendedor ou ML) e o motivo, quando informado.",
  inputSchema: vendasDiariasSchema,
  handler: async ({ seller, dias }) => {
    try {
      const row = resolveSeller(seller);
      const period = lastNDays(dias ?? 30);
      const orders = (await searchAllOrders(seller, row.ml_user_id!, { dateFrom: period.from, dateTo: period.to, maxOrders: 1000 })).filter(
        (o) => o.status === "cancelled"
      );
      const porQuem = new Map<string, number>();
      for (const o of orders) {
        const k = o.cancel_detail?.requested_by ?? "não informado";
        porQuem.set(k, (porQuem.get(k) ?? 0) + 1);
      }
      const lines = orders.map((o) => `- ${ymdBr(o.date_created)} pedido ${o.id} ${brl(o.total_amount)} | por ${o.cancel_detail?.requested_by ?? "n/d"}${o.cancel_detail?.description ? `: ${o.cancel_detail.description}` : ""}`);
      return ok(
        `${orders.length} pedido(s) cancelado(s) em ${period.label}. Por quem: ${[...porQuem.entries()].map(([k, v]) => `${k} ${v}`).join(", ") || "—"}\n${lines.join("\n")}`,
        { periodo: period, porQuem: Object.fromEntries(porQuem), cancelados: orders }
      );
    } catch (err) {
      return toErrorResult(err, "cancelamentos");
    }
  },
};

// =========================== PÓS-VENDA ===========================

const claimsSchema = {
  seller: sellerArg,
  status: z.enum(["opened", "closed"]).optional().describe("Default: opened (abertas)"),
  tipo: z.enum(["mediations", "returns", "fulfillment", "cancel_purchase", "cancel_sale"]).optional().describe("Tipo de reclamação (opcional)"),
  limite: z.number().int().positive().max(100).optional(),
};
export const buscarReclamacoesTool: ToolDefinition<typeof claimsSchema> = {
  name: "buscar_reclamacoes",
  title: "Buscar reclamações",
  description: "Reclamações, mediações e devoluções do vendedor (API de pós-venda), com etapa, motivo, pedido e prazo de ação. Por padrão, as abertas.",
  inputSchema: claimsSchema,
  handler: async ({ seller, status, tipo, limite }) => {
    try {
      resolveSeller(seller);
      const res = await ex.searchClaims(seller, { status: status ?? "opened", type: tipo, limit: limite ?? 30 });
      const data: any[] = res.data ?? res.results ?? [];
      const lines = data.map(
        (c) =>
          `- [${c.id}] ${c.type ?? ""} ${c.stage ?? ""} ${c.status} | pedido/recurso ${c.resource_id ?? "n/d"} | motivo ${c.reason_id ?? "n/d"} | atualizado ${c.last_updated ?? c.date_created}`
      );
      return ok(`${res.paging?.total ?? data.length} reclamação(ões) ${status ?? "opened"} — mostrando ${data.length}:\n${lines.join("\n")}`, { resultado: res });
    } catch (err) {
      return toErrorResult(err, "buscar_reclamacoes");
    }
  },
};

const claimSchema = { seller: sellerArg, reclamacaoId: z.string() };
export const consultarReclamacaoTool: ToolDefinition<typeof claimSchema> = {
  name: "consultar_reclamacao",
  title: "Consultar reclamação",
  description: "Uma reclamação com o motivo em texto, quem deve agir e até quando, ações disponíveis e dados de devolução, se houver.",
  inputSchema: claimSchema,
  handler: async ({ seller, reclamacaoId }) => {
    try {
      resolveSeller(seller);
      const claim = await ex.getClaim(seller, reclamacaoId);
      const [reason, returns] = await Promise.all([
        claim.reason_id ? safe(ex.getClaimReason(seller, claim.reason_id)) : Promise.resolve(null),
        safe(ex.getClaimReturns(seller, reclamacaoId)),
      ]);
      const acoes = (claim.players ?? [])
        .flatMap((p: any) => (p.available_actions ?? []).map((a: any) => `${p.role}: ${a.action}${a.due_date ? ` até ${a.due_date}` : ""}${a.mandatory ? " (obrigatória)" : ""}`))
        .join("\n");
      const motivo = reason && !isErr(reason) ? reason.detail ?? reason.name ?? claim.reason_id : claim.reason_id;
      return ok(
        `Reclamação ${claim.id} — ${claim.type} | etapa ${claim.stage} | status ${claim.status}\nPedido/recurso: ${claim.resource_id}\nMotivo: ${motivo}\nAções pendentes:\n${acoes || "nenhuma"}`,
        { claim, reason, returns }
      );
    } catch (err) {
      return toErrorResult(err, "consultar_reclamacao");
    }
  },
};

// =========================== AVALIAÇÕES ===========================

const reviewsResumoSchema = {
  seller: sellerArg,
  mlbs: z.array(z.string()).max(50).optional().describe("Anúncios a avaliar. Se omitido, usa os 30 anúncios ativos com mais vendas."),
};
export const resumoAvaliacoesTool: ToolDefinition<typeof reviewsResumoSchema> = {
  name: "resumo_avaliacoes",
  title: "Resumo de avaliações",
  description: "Média de estrelas, total de opiniões e distribuição de 1 a 5 estrelas por anúncio, com a média geral da conta.",
  inputSchema: reviewsResumoSchema,
  handler: async ({ seller, mlbs }) => {
    try {
      const row = resolveSeller(seller);
      let ids = mlbs;
      if (!ids?.length) {
        const all = await searchAllItemIds(seller, row.ml_user_id!, 1000);
        const items = await getItemsMultiget(seller, all);
        ids = items.filter((i) => i.status === "active").sort((a, b) => b.sold_quantity - a.sold_quantity).slice(0, 30).map((i) => i.id);
      }
      const res = await mapLimit(ids, 4, async (id) => ({ id, r: await safe(ex.getItemReviews(seller, id, 0, 1)) }));
      const rows = res
        .filter((x) => !isErr(x.r))
        .map(({ id, r }: any) => ({ mlb: id, media: r.rating_average ?? 0, total: r.paging?.total ?? 0, niveis: r.rating_levels ?? {} }));
      const tot = rows.reduce((a, r) => a + r.total, 0);
      const mediaGeral = tot ? rows.reduce((a, r) => a + r.media * r.total, 0) / tot : 0;
      const lines = rows
        .sort((a, b) => a.media - b.media)
        .map((r) => `- ${r.mlb}: ${r.media.toFixed(1)}★ (${r.total} opiniões) | 1★ ${r.niveis.one_star ?? 0} · 2★ ${r.niveis.two_star ?? 0} · 5★ ${r.niveis.five_star ?? 0}`);
      return ok(`Média ponderada da conta: ${mediaGeral.toFixed(2)}★ em ${tot} opiniões (${rows.length} anúncios)\n${lines.join("\n")}`, { mediaGeral, anuncios: rows });
    } catch (err) {
      return toErrorResult(err, "resumo_avaliacoes");
    }
  },
};

const reviewsSchema = {
  seller: sellerArg,
  mlb: z.string(),
  estrelasMax: z.number().int().min(1).max(5).optional().describe("Ex.: 2 para ver só as negativas (1 e 2 estrelas)"),
  limite: z.number().int().positive().max(100).optional(),
};
export const buscarAvaliacoesTool: ToolDefinition<typeof reviewsSchema> = {
  name: "buscar_avaliacoes",
  title: "Buscar avaliações",
  description: "Textos das opiniões de um anúncio, com filtro de estrelas (ex.: estrelasMax=2 para as negativas).",
  inputSchema: reviewsSchema,
  handler: async ({ seller, mlb, estrelasMax, limite }) => {
    try {
      resolveSeller(seller);
      const r = await ex.getItemReviews(seller, mlb, 0, 100);
      const reviews: any[] = (r.reviews ?? []).filter((x: any) => !estrelasMax || x.rate <= estrelasMax).slice(0, limite ?? 30);
      const lines = reviews.map((x) => `- ${x.rate}★ ${ymdBr(x.date_created ?? "")} ${x.title ? `"${x.title}" ` : ""}${x.content ?? ""}`);
      return ok(`${mlb}: ${Number(r.rating_average ?? 0).toFixed(1)}★ em ${r.paging?.total ?? 0} opiniões — ${reviews.length} mostradas:\n${lines.join("\n")}`, {
        media: r.rating_average,
        niveis: r.rating_levels,
        avaliacoes: reviews,
      });
    } catch (err) {
      return toErrorResult(err, "buscar_avaliacoes");
    }
  },
};

// =========================== PERGUNTAS ===========================

const perguntaSchema = { seller: sellerArg, perguntaId: z.string() };
export const consultarPerguntaTool: ToolDefinition<typeof perguntaSchema> = {
  name: "consultar_pergunta",
  title: "Consultar pergunta",
  description: "Uma pergunta de comprador com texto, idade, anúncio (título, preço, estoque) e resposta, se houver — tudo que é preciso para responder bem.",
  inputSchema: perguntaSchema,
  handler: async ({ seller, perguntaId }) => {
    try {
      resolveSeller(seller);
      const q = await ex.getQuestion(seller, perguntaId);
      const item = await safe(getItem(seller, q.item_id));
      const horas = q.date_created ? ((Date.now() - new Date(q.date_created).getTime()) / 3_600_000).toFixed(1) : "n/d";
      const itemTxt = !isErr(item) ? `${item.title} | ${brl(item.price)} | estoque ${item.available_quantity}` : q.item_id;
      return ok(`Pergunta ${q.id} (${q.status}, há ${horas} h) em ${q.item_id}: "${q.text}"\nAnúncio: ${itemTxt}${q.answer ? `\nResposta: "${q.answer.text}"` : ""}`, {
        pergunta: q,
        item,
      });
    } catch (err) {
      return toErrorResult(err, "consultar_pergunta");
    }
  },
};

const tempoSchema = { seller: sellerArg };
export const tempoRespostaPerguntasTool: ToolDefinition<typeof tempoSchema> = {
  name: "tempo_resposta_perguntas",
  title: "Tempo de resposta a perguntas",
  description: "Tempo médio que a conta leva para responder perguntas, total e por faixa (horário comercial, fora do horário, fim de semana).",
  inputSchema: tempoSchema,
  handler: async ({ seller }) => {
    try {
      const row = resolveSeller(seller);
      const r = await ex.getQuestionsResponseTime(seller, row.ml_user_id!);
      const faixa = (x: any) => (x?.response_time !== undefined ? `${x.response_time} min` : "n/d");
      return ok(
        `Tempo médio de resposta: ${faixa(r.total)}\nHorário comercial (seg-sex 9h-18h): ${faixa(r.weekdays_working_hours)}\nFora do horário: ${faixa(r.weekdays_extra_hours)}\nFim de semana: ${faixa(r.weekend)}`,
        { resultado: r }
      );
    } catch (err) {
      return toErrorResult(err, "tempo_resposta_perguntas");
    }
  },
};

// =========================== CATÁLOGO E PREÇO ===========================

const mlbsSchema = { seller: sellerArg, mlbs: z.array(z.string()).min(1).max(30) };

export const precoParaGanharTool: ToolDefinition<typeof mlbsSchema> = {
  name: "preco_para_ganhar",
  title: "Preço para ganhar (catálogo)",
  description: "Para anúncios de catálogo: se está ganhando, dividindo o 1º lugar ou perdendo, o preço para ganhar e os motivos/boosts que faltam.",
  inputSchema: mlbsSchema,
  handler: async ({ seller, mlbs }) => {
    try {
      resolveSeller(seller);
      const res = await mapLimit(mlbs, 4, async (id) => ({ id, r: await safe(ex.getPriceToWin(seller, id)) }));
      const lines = res.map(({ id, r }: any) =>
        isErr(r)
          ? `- ${id}: ${r.erro}`
          : `- ${id}: ${r.status ?? "n/d"} | nosso ${brl(r.current_price)} | para ganhar ${brl(r.price_to_win)}${r.competitors_sharing_first_place ? ` | dividindo com ${r.competitors_sharing_first_place}` : ""}${r.reason?.length ? ` | motivos: ${r.reason.join(", ")}` : ""}`
      );
      return ok(`Competição de catálogo:\n${lines.join("\n")}`, { resultados: res });
    } catch (err) {
      return toErrorResult(err, "preco_para_ganhar");
    }
  },
};

const catalogoSchema = { seller: sellerArg };
export const relatorioCatalogoTool: ToolDefinition<typeof catalogoSchema> = {
  name: "relatorio_catalogo",
  title: "Relatório de catálogo",
  description: "Todos os anúncios de catálogo ativos da conta com a situação na competição (ganhando, dividindo, perdendo) e o preço para ganhar.",
  inputSchema: catalogoSchema,
  handler: async ({ seller }) => {
    try {
      const row = resolveSeller(seller);
      const ids = await searchAllItemIds(seller, row.ml_user_id!, 2000);
      const items = (await getItemsMultiget(seller, ids)).filter((i) => i.catalog_listing && i.status === "active");
      const res = await mapLimit(items, 4, async (i) => ({ i, r: await safe(ex.getPriceToWin(seller, i.id)) }));
      const cont: Record<string, number> = {};
      const lines = res.map(({ i, r }: any) => {
        const st = isErr(r) ? "erro" : r.status ?? "n/d";
        cont[st] = (cont[st] ?? 0) + 1;
        return `- ${i.id} ${i.title} | ${st} | nosso ${brl(i.price)}${!isErr(r) ? ` | para ganhar ${brl(r.price_to_win)}` : ""}`;
      });
      return ok(`${items.length} anúncio(s) de catálogo ativos. Situação: ${Object.entries(cont).map(([k, v]) => `${k} ${v}`).join(", ") || "—"}\n${lines.join("\n")}`, {
        resumo: cont,
        anuncios: res.map(({ i, r }) => ({ mlb: i.id, titulo: i.title, preco: i.price, competicao: r })),
      });
    } catch (err) {
      return toErrorResult(err, "relatorio_catalogo");
    }
  },
};

export const elegibilidadeCatalogoTool: ToolDefinition<typeof mlbsSchema> = {
  name: "elegibilidade_catalogo",
  title: "Elegibilidade para catálogo",
  description: "Quais anúncios podem entrar no catálogo do Mercado Livre e, para os que não podem, o motivo.",
  inputSchema: mlbsSchema,
  handler: async ({ seller, mlbs }) => {
    try {
      resolveSeller(seller);
      const res = await mapLimit(mlbs, 4, async (id) => ({ id, r: await safe(ex.getCatalogEligibility(seller, id)) }));
      const lines = res.map(({ id, r }: any) =>
        isErr(r) ? `- ${id}: ${r.erro}` : `- ${id}: ${r.buy_box_eligible ? "elegível" : "não elegível"} | status ${r.status ?? "n/d"}${r.reason ? ` | ${r.reason}` : ""}`
      );
      return ok(`Elegibilidade para catálogo:\n${lines.join("\n")}`, { resultados: res });
    } catch (err) {
      return toErrorResult(err, "elegibilidade_catalogo");
    }
  },
};

export const sugestaoPrecoTool: ToolDefinition<typeof mlbsSchema> = {
  name: "sugestao_preco",
  title: "Sugestão de preço do ML",
  description: "Sugestão de preço do Mercado Livre por anúncio (quando existe): preço atual, sugerido e preços de referência de concorrentes.",
  inputSchema: mlbsSchema,
  handler: async ({ seller, mlbs }) => {
    try {
      resolveSeller(seller);
      const res = await mapLimit(mlbs, 4, async (id) => ({ id, r: await safe(ex.getPriceSuggestion(seller, id)) }));
      const lines = res.map(({ id, r }: any) =>
        isErr(r)
          ? `- ${id}: sem sugestão (${r.erro})`
          : `- ${id}: atual ${brl(r.current_price?.amount)} | sugerido ${brl(r.suggested_price?.amount)} | menor concorrente ${brl(r.lowest_price?.amount)}${r.status ? ` | ${r.status}` : ""}`
      );
      return ok(`Sugestões de preço:\n${lines.join("\n")}`, { resultados: res });
    } catch (err) {
      return toErrorResult(err, "sugestao_preco");
    }
  },
};

const tipoSchema = { seller: sellerArg, mlb: z.string() };
export const tiposAnuncioTool: ToolDefinition<typeof tipoSchema> = {
  name: "tipos_anuncio",
  title: "Tipo de anúncio (Clássico/Premium)",
  description: "Tipo atual do anúncio, upgrades e downgrades disponíveis e a tarifa de venda de cada tipo no preço atual.",
  inputSchema: tipoSchema,
  handler: async ({ seller, mlb }) => {
    try {
      resolveSeller(seller);
      const item = await getItem(seller, mlb);
      const [up, down, fees] = await Promise.all([
        safe(ex.getAvailableUpgrades(seller, mlb)),
        safe(ex.getAvailableDowngrades(seller, mlb)),
        safe(ex.getListingPrices(seller, mlb.slice(0, 3), item.price, item.category_id)),
      ]);
      const feeLines = Array.isArray(fees)
        ? fees.map((f: any) => `- ${f.listing_type_name ?? f.listing_type_id}: tarifa ${brl(f.sale_fee_amount)}${f.sale_fee_details?.percentage_fee ? ` (${f.sale_fee_details.percentage_fee}%)` : ""}`)
        : [];
      const nomes = (x: any) => (Array.isArray(x) ? x.map((t: any) => t.name ?? t.id).join(", ") || "nenhum" : "n/d");
      return ok(
        `${mlb} — tipo atual: ${item.listing_type_id} | preço ${brl(item.price)}\nUpgrades: ${nomes(up)}\nDowngrades: ${nomes(down)}\nTarifas por tipo neste preço:\n${feeLines.join("\n")}`,
        { item: { id: item.id, listing_type_id: item.listing_type_id, price: item.price }, upgrades: up, downgrades: down, tarifas: fees }
      );
    } catch (err) {
      return toErrorResult(err, "tipos_anuncio");
    }
  },
};

// =========================== QUALIDADE, PROMOÇÕES, FULL ===========================

const qualidadeSchema = {
  seller: sellerArg,
  mlbs: z.array(z.string()).max(50).optional().describe("Se omitido, usa os 30 anúncios ativos com mais vendas"),
};
export const qualidadeAnunciosTool: ToolDefinition<typeof qualidadeSchema> = {
  name: "qualidade_anuncios",
  title: "Qualidade das publicações",
  description: "Nota de qualidade de cada anúncio (relatório de performance do ML) com as oportunidades de melhoria pendentes (fotos, ficha técnica, descrição etc.).",
  inputSchema: qualidadeSchema,
  handler: async ({ seller, mlbs }) => {
    try {
      const row = resolveSeller(seller);
      let ids = mlbs;
      if (!ids?.length) {
        const all = await searchAllItemIds(seller, row.ml_user_id!, 1000);
        const items = await getItemsMultiget(seller, all);
        ids = items.filter((i) => i.status === "active").sort((a, b) => b.sold_quantity - a.sold_quantity).slice(0, 30).map((i) => i.id);
      }
      const res = await mapLimit(ids, 4, async (id) => ({ id, r: await safe(ex.getItemPerformance(seller, id)) }));
      const lines = res.map(({ id, r }: any) => {
        if (isErr(r)) return `- ${id}: ${r.erro}`;
        const pend = (r.buckets ?? [])
          .flatMap((b: any) => (b.variables ?? []).flatMap((v: any) => (v.rules ?? []).filter((x: any) => x.status === "PENDING").map((x: any) => x.wordings?.title ?? x.key)))
          .slice(0, 5);
        return `- ${id}: nota ${r.score ?? "n/d"} (${r.level_wording ?? r.level ?? ""})${pend.length ? ` | pendências: ${pend.join("; ")}` : ""}`;
      });
      return ok(`Qualidade das publicações:\n${lines.join("\n")}`, { resultados: res });
    } catch (err) {
      return toErrorResult(err, "qualidade_anuncios");
    }
  },
};

const promoItemSchema = { seller: sellerArg, mlb: z.string() };
export const promocoesDoAnuncioTool: ToolDefinition<typeof promoItemSchema> = {
  name: "promocoes_do_anuncio",
  title: "Promoções do anúncio",
  description: "Todas as promoções ligadas a um anúncio: ativas, programadas e convites (candidatas), com preço promocional e período.",
  inputSchema: promoItemSchema,
  handler: async ({ seller, mlb }) => {
    try {
      resolveSeller(seller);
      const r = await ex.getItemPromotions(seller, mlb);
      const arr: any[] = Array.isArray(r) ? r : r.results ?? [];
      const lines = arr.map(
        (p) =>
          `- ${p.type} ${p.name ?? p.id ?? ""} | ${p.status} | preço ${brl(p.price ?? p.new_price)}${p.original_price ? ` (de ${brl(p.original_price)})` : ""}${p.start_date ? ` | ${ymdBr(p.start_date)} a ${ymdBr(p.finish_date ?? "")}` : ""}`
      );
      return ok(`${arr.length} promoção(ões) para ${mlb}:\n${lines.join("\n")}`, { promocoes: arr });
    } catch (err) {
      return toErrorResult(err, "promocoes_do_anuncio");
    }
  },
};

const fullSchema = { seller: sellerArg, mlbs: z.array(z.string()).max(50).optional().describe("Se omitido, todos os anúncios Full ativos") };
export const estoqueFullTool: ToolDefinition<typeof fullSchema> = {
  name: "estoque_full",
  title: "Estoque no Full",
  description: "Estoque no Fulfillment (Full) por anúncio: total, disponível para venda e indisponível por motivo (danificado, perdido, em transferência etc.).",
  inputSchema: fullSchema,
  handler: async ({ seller, mlbs }) => {
    try {
      const row = resolveSeller(seller);
      const ids = mlbs?.length ? mlbs : await searchAllItemIds(seller, row.ml_user_id!, 2000);
      const items = (await getItemsMultiget(seller, ids)).filter((i) => i.inventory_id && (mlbs?.length || i.status === "active"));
      const res = await mapLimit(items, 4, async (i) => ({ i, r: await safe(ex.getFulfillmentStock(seller, i.inventory_id!)) }));
      const lines = res.map(({ i, r }: any) =>
        isErr(r)
          ? `- ${i.id}: ${r.erro}`
          : `- ${i.id} ${i.title} | total ${r.total ?? "n/d"} | disponível ${r.available_quantity ?? "n/d"} | indisponível ${r.not_available_quantity ?? 0}${
              r.not_available_detail?.length ? ` (${r.not_available_detail.map((d: any) => `${d.status} ${d.quantity}`).join(", ")})` : ""
            }`
      );
      return ok(`${items.length} anúncio(s) com estoque no Full:\n${lines.join("\n")}`, { resultados: res.map(({ i, r }) => ({ mlb: i.id, estoque: r })) });
    } catch (err) {
      return toErrorResult(err, "estoque_full");
    }
  },
};

const visitasContaSchema = { seller: sellerArg, dias: diasArg(30, 150) };
export const visitasDiariasContaTool: ToolDefinition<typeof visitasContaSchema> = {
  name: "visitas_diarias_conta",
  title: "Visitas da conta por dia",
  description: "Visitas totais de todos os anúncios do vendedor, dia a dia.",
  inputSchema: visitasContaSchema,
  handler: async ({ seller, dias }) => {
    try {
      const row = resolveSeller(seller);
      const r = await ex.getSellerVisitsTimeWindow(seller, row.ml_user_id!, dias ?? 30);
      const res: any[] = r.results ?? [];
      const lines = res.map((d) => `${ymdBr(d.date)}: ${d.total}`);
      return ok(`Visitas por dia (total ${r.total_visits ?? res.reduce((a, d) => a + (d.total ?? 0), 0)}):\n${lines.join("\n")}`, { resultado: r });
    } catch (err) {
      return toErrorResult(err, "visitas_diarias_conta");
    }
  },
};

// =========================== FATURAMENTO ===========================

const billPeriodsSchema = { seller: sellerArg, grupo: z.enum(["ML", "MP"]).optional().describe("ML = Mercado Livre (default), MP = Mercado Pago") };
export const faturamentoPeriodosTool: ToolDefinition<typeof billPeriodsSchema> = {
  name: "faturamento_periodos",
  title: "Faturas do Mercado Livre",
  description: "Faturas mensais do Mercado Livre (ou Mercado Pago) dos últimos 12 meses: período, valor e status. A chave de cada período serve para faturamento_resumo.",
  inputSchema: billPeriodsSchema,
  handler: async ({ seller, grupo }) => {
    try {
      resolveSeller(seller);
      const r = await ex.getBillingPeriods(seller, grupo ?? "ML", 12);
      const res: any[] = r.results ?? [];
      const lines = res.map((p) => `- ${p.key}: ${ymdBr(p.period?.date_from ?? "")} a ${ymdBr(p.period?.date_to ?? "")} | ${brl(p.amount)} | ${p.period_status ?? p.status ?? ""}`);
      return ok(`Faturas (${grupo ?? "ML"}):\n${lines.join("\n")}`, { resultado: r });
    } catch (err) {
      return toErrorResult(err, "faturamento_periodos");
    }
  },
};

const billSummarySchema = { seller: sellerArg, chave: z.string().describe("Chave do período (ver faturamento_periodos), ex.: 2026-09-01"), grupo: z.enum(["ML", "MP"]).optional() };
export const faturamentoResumoTool: ToolDefinition<typeof billSummarySchema> = {
  name: "faturamento_resumo",
  title: "Resumo de uma fatura",
  description: "Encargos e bonificações de um período de faturamento por categoria (vendas, envios, publicidade, Full, outros).",
  inputSchema: billSummarySchema,
  handler: async ({ seller, chave, grupo }) => {
    try {
      resolveSeller(seller);
      const r = await ex.getBillingSummary(seller, chave, grupo ?? "ML");
      const charges: any[] = r.bill_includes?.charges ?? r.charges ?? [];
      const bonuses: any[] = r.bill_includes?.bonuses ?? r.bonuses ?? [];
      const fmt = (x: any) => `- ${x.label ?? x.type ?? x.name}: ${brl(x.amount)}`;
      return ok(`Fatura ${chave} (${grupo ?? "ML"})\nEncargos:\n${charges.map(fmt).join("\n") || "—"}\nBonificações:\n${bonuses.map(fmt).join("\n") || "—"}`, { resultado: r });
    } catch (err) {
      return toErrorResult(err, "faturamento_resumo");
    }
  },
};

// =========================== DIAGNÓSTICO DE ANÚNCIO ===========================

const diagSchema = { seller: sellerArg, mlb: z.string(), dias: diasArg(30) };
export const diagnosticoAnuncioTool: ToolDefinition<typeof diagSchema> = {
  name: "diagnostico_anuncio",
  title: "Diagnóstico completo de um anúncio",
  description:
    "Tudo que explica a saúde de UM anúncio: dados e status, vendas e visitas no período com conversão, qualidade da publicação, avaliações, competição de catálogo, promoções e tipo de anúncio.",
  inputSchema: diagSchema,
  handler: async ({ seller, mlb, dias }) => {
    try {
      const row = resolveSeller(seller);
      const period = lastNDays(dias ?? 30);
      const item = await getItem(seller, mlb);
      const [visits, orders, perf, reviews, ptw, promos] = await Promise.all([
        safe(getItemsVisits(seller, [mlb], period.from, period.to)),
        safe(searchAllOrders(seller, row.ml_user_id!, { dateFrom: period.from, dateTo: period.to, maxOrders: 1000 })),
        safe(ex.getItemPerformance(seller, mlb)),
        safe(ex.getItemReviews(seller, mlb, 0, 5)),
        item.catalog_listing ? safe(ex.getPriceToWin(seller, mlb)) : Promise.resolve(null),
        safe(ex.getItemPromotions(seller, mlb)),
      ]);
      const v = !isErr(visits) ? visits[mlb] ?? 0 : null;
      let un = 0;
      let ped = 0;
      if (!isErr(orders))
        for (const o of orders)
          if (PAGOS.has(o.status))
            for (const oi of o.order_items)
              if (oi.item.id === mlb) {
                un += oi.quantity;
                ped++;
              }
      const conv = v ? ((ped / v) * 100).toFixed(2).replace(".", ",") + "%" : "n/d";
      const linhas = [
        `${mlb} — ${item.title}`,
        `Status ${item.status} | ${brl(item.price)} | estoque ${item.available_quantity} | ${item.listing_type_id} | logística ${item.shipping?.logistic_type ?? "n/d"}${item.catalog_listing ? " | catálogo" : ""}`,
        `${period.label}: ${v ?? "n/d"} visitas | ${ped} pedidos | ${un} un | conversão ${conv}`,
        `Qualidade: ${!isErr(perf) ? `${perf.score ?? "n/d"} (${perf.level_wording ?? perf.level ?? ""})` : perf.erro}`,
        `Avaliações: ${!isErr(reviews) ? `${Number(reviews.rating_average ?? 0).toFixed(1)}★ em ${reviews.paging?.total ?? 0}` : reviews.erro}`,
      ];
      if (ptw) linhas.push(`Catálogo: ${!isErr(ptw) ? `${ptw.status} | para ganhar ${brl(ptw.price_to_win)}` : ptw.erro}`);
      if (!isErr(promos)) {
        const arr: any[] = Array.isArray(promos) ? promos : promos.results ?? [];
        linhas.push(`Promoções: ${arr.filter((p) => p.status === "started").length} ativa(s), ${arr.filter((p) => p.status === "candidate").length} convite(s)`);
      }
      return ok(linhas.join("\n"), { item, periodo: period, visitas: v, pedidos: ped, unidades: un, qualidade: perf, avaliacoes: reviews, catalogo: ptw, promocoes: promos });
    } catch (err) {
      return toErrorResult(err, "diagnostico_anuncio");
    }
  },
};

export const paridadeTools: ToolDefinition<any>[] = [
  consultarPedidoTool,
  custosPedidosTool,
  vendasDiariasTool,
  vendasPorAnuncioTool,
  cancelamentosTool,
  buscarReclamacoesTool,
  consultarReclamacaoTool,
  resumoAvaliacoesTool,
  buscarAvaliacoesTool,
  consultarPerguntaTool,
  tempoRespostaPerguntasTool,
  precoParaGanharTool,
  relatorioCatalogoTool,
  elegibilidadeCatalogoTool,
  sugestaoPrecoTool,
  tiposAnuncioTool,
  qualidadeAnunciosTool,
  promocoesDoAnuncioTool,
  estoqueFullTool,
  visitasDiariasContaTool,
  faturamentoPeriodosTool,
  faturamentoResumoTool,
  diagnosticoAnuncioTool,
];

void errorResult;
