import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { allTools } from "../tools/index.js";
import { childLogger } from "../utils/logger.js";
import { recordAudit } from "../database/sellersRepo.js";

const log = childLogger("mcp-server");

/**
 * Cria uma instância do McpServer com todas as tools do Enginne registradas.
 * Uma instância NOVA é criada por sessão HTTP (ver server/index.ts) — é o
 * padrão recomendado pelo SDK para não vazar estado entre clientes/sessões.
 */
export function createEnginneServer(): McpServer {
  const server = new McpServer(
    {
      name: "mercado-livre-enginne",
      version: "0.1.0",
    },
    {
      capabilities: { tools: {} },
      instructions:
        "Enginne é um conector para contas do Mercado Livre administradas pelo usuário: leitura de vendas/anúncios/campanhas de Ads, e escrita (criar/editar anúncios). " +
        "Sempre comece uma análise chamando listar_contas() para descobrir os nomes de seller disponíveis. " +
        "Todas as tools recebem `seller` como o nome interno (não o nickname do Mercado Livre). " +
        "consultar_campanhas / consultar_metricas_campanha trazem dados de Product Ads (valor investido, vendas atribuídas, ACOS, ROAS) — diferente de consultar_promocoes, que é sobre descontos/cupons sem custo de mídia. " +
        "criar_anuncio e editar_anuncio alteram dados reais no Mercado Livre: por padrão (confirmar=false ou omitido) elas só retornam uma PRÉVIA do que seria feito, sem executar nada. " +
        "SEMPRE mostre essa prévia para a pessoa e espere confirmação explícita antes de chamar a tool de novo com confirmar=true — nunca pule direto para confirmar=true numa única resposta.",
    }
  );

  for (const tool of allTools) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
      },
      async (args: any) => {
        const sellerArg = typeof args?.seller === "string" ? args.seller : null;
        try {
          const result = await tool.handler(args);
          recordAudit(sellerArg, "tool_call", tool.name);
          return result;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          log.error({ tool: tool.name, seller: sellerArg, err: message }, "erro não tratado na tool");
          recordAudit(sellerArg, "tool_call_error", `${tool.name}: ${message}`);
          return {
            content: [{ type: "text" as const, text: `Erro inesperado em ${tool.name}: ${message}` }],
            isError: true,
          };
        }
      }
    );
  }

  log.info({ toolCount: allTools.length }, "servidor MCP configurado");
  return server;
}
