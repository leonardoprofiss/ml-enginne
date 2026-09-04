import { z } from "zod";
import { resolveSeller } from "./resolveSeller.js";
import { ok, toErrorResult, type ToolDefinition } from "./types.js";
import { lastNDays, lastNDaysYmd } from "./dateUtils.js";
import { searchAllOrders } from "../mercadolivre/endpoints.js";
import { computeTotals } from "./analytics.js";
import { listAdvertisers, listCampaigns, type MlCampaign } from "../mercadolivre/advertisingEndpoints.js";

/**
 * Relatório de performance — junta vendas (orgânicas + atribuídas a Ads) num
 * resumo único, pronto pra virar (ou abrir) uma entrega de cliente. Não
 * inventa nenhuma métrica nova: só compõe consultar_vendas + consultar_campanhas
 * num texto já pronto, com as contas cruzadas feitas (% das vendas vindas de
 * Ads, TACOS = investido/receita total) que dariam trabalho fazer na mão
 * juntando duas tools separadas.
 */

function fmtMoney(n: number | undefined): string {
  return n === undefined ? "n/d" : `R$ ${n.toFixed(2)}`;
}

function fmtPct(n: number | undefined): string {
  return n === undefined ? "n/d" : `${n.toFixed(1)}%`;
}

const relatorioSchema = {
  seller: z.string().describe("Nome interno do seller (ver listar_contas)"),
  dias: z.number().int().positive().max(90).optional().describe("Janela em dias contados até agora (default 30). Limitado a 90 porque a Advertising API não permite mais que isso por chamada."),
};

export const gerarRelatorioDesempenhoTool: ToolDefinition<typeof relatorioSchema> = {
  name: "gerar_relatorio_desempenho",
  title: "Gerar relatório de desempenho (vendas + Ads)",
  description:
    "Junta vendas totais e, quando a conta tem Product Ads habilitado, investimento/retorno de campanhas num resumo único: faturamento, % das vendas que vieram de Ads, ACOS/ROAS geral, e TACOS (investido em Ads sobre a receita total). Pensado para virar direto o ponto de partida de uma entrega/relatório de cliente. Para o detalhe campanha a campanha, use consultar_campanhas; para Ad Groups/itens, consultar_ad_groups/consultar_itens_ad_group.",
  inputSchema: relatorioSchema,
  handler: async ({ seller, dias }) => {
    try {
      const row = resolveSeller(seller);
      const janela = dias ?? 30;
      const period = lastNDays(janela);
      const periodYmd = lastNDaysYmd(janela);

      const orders = await searchAllOrders(seller, row.ml_user_id!, { dateFrom: period.from, dateTo: period.to });
      const vendas = computeTotals(orders);

      const advertisers = await listAdvertisers(seller, "PADS");
      let adsSection = `Product Ads: conta sem Product Ads habilitado (ou nunca configurou uma campanha) — sem dados de Ads neste relatório.`;
      let adsData: { campaigns: MlCampaign[]; totals: { cost: number; totalAmount: number; clicks: number; prints: number } } | null = null;

      if (advertisers.length > 0) {
        const { advertiser_id: advertiserId, site_id: siteId } = advertisers[0];
        const campanhasRes = await listCampaigns(seller, siteId, advertiserId, {
          dateFrom: periodYmd.from,
          dateTo: periodYmd.to,
          limit: 100,
        });
        const campaigns = campanhasRes.results ?? [];
        const adsTotals = campaigns.reduce(
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
        adsData = { campaigns, totals: adsTotals };

        const acosGeral = adsTotals.totalAmount > 0 ? (adsTotals.cost / adsTotals.totalAmount) * 100 : undefined;
        const roasGeral = adsTotals.cost > 0 ? adsTotals.totalAmount / adsTotals.cost : undefined;
        const shareVendasAds = vendas.revenue > 0 ? (adsTotals.totalAmount / vendas.revenue) * 100 : undefined;
        const tacos = vendas.revenue > 0 ? (adsTotals.cost / vendas.revenue) * 100 : undefined;
        const ativas = campaigns.filter((c) => c.status === "active").length;

        const topCampanha = [...campaigns].sort((a, b) => (b.metrics?.cost ?? 0) - (a.metrics?.cost ?? 0))[0];

        adsSection =
          `Product Ads: ${campaigns.length} campanha(s) no período (${ativas} ativa(s))\n` +
          `  Investido: ${fmtMoney(adsTotals.cost)} | vendas atribuídas: ${fmtMoney(adsTotals.totalAmount)} | ACOS geral: ${fmtPct(acosGeral)} | ROAS geral: ${roasGeral !== undefined ? roasGeral.toFixed(2) + "x" : "n/d"}\n` +
          `  Cliques: ${adsTotals.clicks} | Impressões: ${adsTotals.prints}\n` +
          `  TACOS (investido/receita total): ${fmtPct(tacos)} | % da receita total vinda de Ads: ${fmtPct(shareVendasAds)}` +
          (topCampanha ? `\n  Campanha com maior investimento: ${topCampanha.name} (${fmtMoney(topCampanha.metrics?.cost)})` : "");
      }

      const texto =
        `RELATÓRIO DE DESEMPENHO — ${seller} (${period.label})\n\n` +
        `VENDAS\n` +
        `  Faturamento: ${fmtMoney(vendas.revenue)} | pedidos pagos: ${vendas.orders} | unidades: ${vendas.units} | ticket médio: ${fmtMoney(vendas.avgTicket)}\n\n` +
        adsSection;

      return ok(texto, { period, vendas, ads: adsData });
    } catch (err) {
      return toErrorResult(err, "gerar_relatorio_desempenho");
    }
  },
};
