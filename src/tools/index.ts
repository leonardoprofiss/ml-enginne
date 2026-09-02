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

/**
 * Registro central de todas as tools MCP expostas pelo Enginne (V1 — somente
 * leitura). Adicionar uma tool nova = criar o ToolDefinition no módulo certo
 * e listar aqui. src/server/mcpServer.ts itera esta lista e chama
 * server.registerTool() para cada uma — nenhum outro lugar do código precisa
 * saber quantas tools existem.
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
  buscarProdutosSemVendasTool,
  compararPeriodosTool,
  analisarQuedaVendasTool,
  diagnosticarIntegracaoTool,
];
