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
import { consultarVisitasTool, consultarPerguntasTool } from "./engajamento.js";
import { consultarEnviosTool, consultarReputacaoTool, consultarPromocoesTool } from "./logistica.js";
import { buscarProdutosSemVendasTool, compararPeriodosTool, analisarQuedaVendasTool } from "./analises.js";
import { diagnosticarIntegracaoTool } from "./diagnostico.js";
import { consultarCampanhasTool, consultarMetricasCampanhaTool } from "./campanhas.js";
import { criarAnuncioTool, editarAnuncioTool } from "./escrita.js";

/**
 * Registro central de todas as tools MCP expostas pelo Enginne (V2 — leitura
 * + campanhas de Ads + escrita de anúncios). Adicionar uma tool nova = criar
 * o ToolDefinition no módulo certo e listar aqui. src/server/mcpServer.ts
 * itera esta lista e chama server.registerTool() para cada uma — nenhum
 * outro lugar do código precisa saber quantas tools existem.
 *
 * As tools de escrita (criarAnuncioTool, editarAnuncioTool) exigem que o
 * seller tenha reautorizado com escopo "write" (ver auth/oauth.ts) — sellers
 * autorizados só na V1 (somente "read") recebem erro 403 da ML até rodar
 * `npm run oauth:add-seller` de novo para esse seller.
 */
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
  consultarEnviosTool,
  consultarReputacaoTool,
  consultarPromocoesTool,
  consultarCampanhasTool,
  consultarMetricasCampanhaTool,
  buscarProdutosSemVendasTool,
  compararPeriodosTool,
  analisarQuedaVendasTool,
  diagnosticarIntegracaoTool,
  criarAnuncioTool,
  editarAnuncioTool,
];
