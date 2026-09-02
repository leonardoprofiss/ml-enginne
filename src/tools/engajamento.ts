import { z } from "zod";
import { resolveSeller } from "./resolveSeller.js";
import { ok, toErrorResult, type ToolDefinition } from "./types.js";
import { getItemsVisits, searchQuestions } from "../mercadolivre/endpoints.js";
import { lastNDays } from "./dateUtils.js";

const visitasSchema = {
  seller: z.string().describe("Nome interno do seller"),
  mlbs: z.array(z.string()).min(1).max(50).describe("Lista de IDs de anúncios (MLB...) a consultar, até 50 por chamada"),
  dias: z.number().int().positive().max(365).optional().describe("Janela em dias (default 30)"),
};

export const consultarVisitasTool: ToolDefinition<typeof visitasSchema> = {
  name: "consultar_visitas",
  title: "Consultar visitas",
  description: "Retorna o total de visitas recebidas por um conjunto de anúncios em uma janela de dias.",
  inputSchema: visitasSchema,
  handler: async ({ seller, mlbs, dias }) => {
    try {
      resolveSeller(seller);
      const period = lastNDays(dias ?? 30);
      const visits = await getItemsVisits(seller, mlbs, period.from, period.to);
      const lines = Object.entries(visits).map(([id, v]) => `- ${id}: ${v} visitas`);
      return ok(`Visitas em ${period.label}:\n${lines.join("\n")}`, { period, visits });
    } catch (err) {
      return toErrorResult(err, "consultar_visitas");
    }
  },
};

const perguntasSchema = {
  seller: z.string().describe("Nome interno do seller"),
  status: z
    .enum(["UNANSWERED", "ANSWERED", "todos"])
    .optional()
    .describe('Filtrar por status da pergunta. Default: "UNANSWERED".'),
  limite: z.number().int().positive().max(200).optional().describe("Máximo de perguntas a retornar (default 50)"),
};

export const consultarPerguntasTool: ToolDefinition<typeof perguntasSchema> = {
  name: "consultar_perguntas",
  title: "Consultar perguntas",
  description: "Lista perguntas recebidas pelos anúncios do seller (por padrão, as ainda não respondidas).",
  inputSchema: perguntasSchema,
  handler: async ({ seller, status, limite }) => {
    try {
      const row = resolveSeller(seller);
      const st = status && status !== "todos" ? status : "UNANSWERED";
      const res = await searchQuestions(seller, row.ml_user_id!, { status: st, limit: limite ?? 50 });
      const lines = res.questions.map((q) => `- [${q.id}] item ${q.item_id}: "${q.text}" (${q.date_created})`);
      return ok(`${res.total} pergunta(s) com status ${st} — mostrando ${res.questions.length}:\n${lines.join("\n")}`, {
        total: res.total,
        questions: res.questions,
      });
    } catch (err) {
      return toErrorResult(err, "consultar_perguntas");
    }
  },
};
