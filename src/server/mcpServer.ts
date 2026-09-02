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
        "Enginne é um conector somente-leitura para contas do Mercado Livre administradas pelo usuário. " +
        "Sempre comece uma análise chamando listar_contas() para descobrir os nomes de seller disponíveis. " +
        "Todas as tools recebem `seller` como o nome interno (não o nickname do Mercado Livre). " +
        "Esta é a V1: nenhuma tool altera dados (sem escrita) — preço, estoque, anúncios e descrições só podem ser lidos.",
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
