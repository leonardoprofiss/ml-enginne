import type { z } from "zod";

/**
 * Formato comum de retorno de uma tool MCP: texto (para o Claude ler/narrar)
 * mais os dados estruturados brutos (para o Claude computar em cima, se
 * precisar). NUNCA inclua token/segredo em nenhum campo aqui.
 */
export interface ToolResult {
  [x: string]: unknown;
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

export interface ToolDefinition<TSchema extends z.ZodRawShape = z.ZodRawShape> {
  name: string;
  title: string;
  description: string;
  inputSchema: TSchema;
  handler: (args: z.infer<z.ZodObject<TSchema>>) => Promise<ToolResult>;
}

export function ok(text: string, structuredContent?: Record<string, unknown>): ToolResult {
  return { content: [{ type: "text", text }], structuredContent };
}

export function errorResult(text: string): ToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

/** Converte qualquer erro em uma ToolResult de erro, com mensagem amigável (sem stack/segredos). */
export function toErrorResult(err: unknown, context: string): ToolResult {
  const message = err instanceof Error ? err.message : String(err);
  return errorResult(`Erro em ${context}: ${message}`);
}
