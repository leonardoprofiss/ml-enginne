import type { ToolDefinition } from "./types.js";
import { listarContasTool, consultarSellerTool } from "./contas.js";
import {
  listarAnunciosTool,
  consultarAnuncioTool,
  consultarStatusAnuncioTool,
  consultarEstoqueTool,
  consultarPrecoTool,
} from "./anuncios.js";
import { consultarVendasTool, consultarPedidosTool } from "./vendas.js";
import { consultarVisitasTool, consultarPerguntasTool, responderPerguntaTool } from "./engajamento.js";
import { consultarEnviosTool, consultarReputacaoTool, consultarPromocoesTool } from "./logistica.js";
import { buscarProdutosSemVendasTool, compararPeriodosTool, analisarQuedaVendasTool } from "./analises.js";
import { diagnosticarIntegracaoTool } from "./diagnostico.js";
import {
  consultarCampanhasTool,
  consultarMetricasCampanhaTool,
  consultarCompetitividadeCampanhaTool,
  consultarAdGroupsTool,
  consultarItensAdGroupTool,
  buscarAdGroupPorSkuTool,
} from "./campanhas.js";
import { criarAnuncioTool, editarAnuncioTool } from "./escrita.js";
import { pesquisarMercadoTool, compararConcorrenciaTool } from "./mercado.js";
import { gerarRelatorioDesempenhoTool } from "./relatorio.js";
import {
  consultarProdutoBlingTool,
  listarProdutosBlingTool,
  editarProdutoBlingTool,
  buscarProdutosSemNcmBlingTool,
} from "./blingProdutos.js";

export const allTools: ToolDefinition<any>[] = [
  listarContasTool,
  consultarSellerTool,
  listarAnunciosTool,
  consultarAnuncioTool,
  consultarStatusAnuncioTool,
  consultarEstoqueTool,
  consultarPrecoTool,
  consultarVendasTool,
  consultarPedidosTool,
  consultarVisitasTool,
  consultarPerguntasTool,
  responderPerguntaTool,
  consultarEnviosTool,
  consultarReputacaoTool,
  consultarPromocoesTool,
  consultarCampanhasTool,
  consultarMetricasCampanhaTool,
  consultarCompetitividadeCampanhaTool,
  consultarAdGroupsTool,
  consultarItensAdGroupTool,
  buscarAdGroupPorSkuTool,
  buscarProdutosSemVendasTool,
  compararPeriodosTool,
  analisarQuedaVendasTool,
  diagnosticarIntegracaoTool,
  criarAnuncioTool,
  editarAnuncioTool,
  pesquisarMercadoTool,
  compararConcorrenciaTool,
  gerarRelatorioDesempenhoTool,
  consultarProdutoBlingTool,
  listarProdutosBlingTool,
  editarProdutoBlingTool,
  buscarProdutosSemNcmBlingTool,
];
