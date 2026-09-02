import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createEnginneServer } from "./mcpServer.js";
import { childLogger } from "../utils/logger.js";

/**
 * Entrada para uso LOCAL (ex.: Claude Desktop apontando para este processo
 * via comando, sem precisar de rede/HTTPS). Útil para testar as tools antes
 * de publicar a versão remota. Ver README > "Testando localmente".
 */
const log = childLogger("stdio-entry");

async function main() {
  const server = createEnginneServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log.info("Enginne MCP server rodando via stdio");
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("Falha ao iniciar servidor stdio:", err);
  process.exit(1);
});
