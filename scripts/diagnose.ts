import { diagnosticarIntegracaoTool } from "../src/tools/diagnostico.js";

const seller = process.argv[2];
const result = await diagnosticarIntegracaoTool.handler({ seller });
console.log(result.content.map((c) => c.text).join("\n"));
process.exit(result.isError ? 1 : 0);
