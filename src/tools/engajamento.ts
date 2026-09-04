import { z } from "zod";
import { resolveSeller } from "./resolveSeller.js";
import { ok, toErrorResult, type ToolDefinition } from "./types.js";
import { getItemsVisits, searchQuestions, answerQuestion } from "../mercadolivre/endpoints.js";
import { recordAudit } from "../database/sellersRepo.js";
import { lastNDaysYmd } from "./dateUtils.js";

const visitasSchema = {
  seller: z.string().describe("Nome interno do seller"),
  mlbs: z.array(z.string()).min(1).max(50).describe("Lista de IDs de anúncios (MLB...) a consultar, até 50 por chamada"),
  dias: z.number().int().positive().max(150).optional().describe("Janela em dias (default 30). Limitado a 150 porque é o máximo que a API de Visitas do Mercado Livre aceita por chamada."),
};

export const consultarVisitasTool: ToolDefinition<typeof visitasSchema> = {
  name: "consultar_visitas",
  title: "Consultar visitas",
  description: "Retorna o total de visitas recebidas por um conjunto de anúncios em uma janela de dias.",
  inputSchema: visitasSchema,
  handler: async ({ seller, mlbs, dias }) => {
    try {
      resolveSeller(seller);
      // date_from/date_to da API de Visitas exigem YYYY-MM-DD — um ISO completo
      // (com hora/milissegundos) é rejeitado com "unknown date format".
      const period = lastNDaysYmd(dias ?? 30);
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

// ---- responder_pergunta ----

const responderPerguntaSchema = {
  seller: z.string().describe("Nome interno do seller"),
  perguntaId: z.string().describe("ID da pergunta a responder (ver consultar_perguntas)"),
  texto: z.string().min(1).max(2000).describe("Texto da resposta (máximo 2000 caracteres, mesmo limite que a ML aplica)"),
  confirmar: z
    .boolean()
    .optional()
    .describe(
      "Só publica a resposta de fato quando true. Default false: nesse caso a tool só mostra uma prévia do que seria respondido, sem publicar nada."
    ),
};

export const responderPerguntaTool: ToolDefinition<typeof responderPerguntaSchema> = {
  name: "responder_pergunta",
  title: "Responder pergunta de comprador",
  description:
    "Publica uma resposta para uma pergunta feita por um comprador em um anúncio. AÇÃO PÚBLICA: fica visível para todo mundo no anúncio e, até onde a documentação da ML indica, não há como apagar/editar depois. Por padrão só mostra uma prévia — chame de novo com confirmar=true para publicar de verdade.",
  inputSchema: responderPerguntaSchema,
  handler: async ({ seller, perguntaId, texto, confirmar }) => {
    try {
      resolveSeller(seller);

      if (!confirmar) {
        return ok(
          `PRÉVIA — nada foi publicado ainda. Isto vai responder a pergunta ${perguntaId} para ${seller} com o texto:\n\n"${texto}"\n\n` +
            `Se estiver correto, chame responder_pergunta novamente com os mesmos dados e confirmar=true para publicar de verdade.`,
          { preview: true, wouldAnswer: { seller, perguntaId, texto } }
        );
      }

      const res = await answerQuestion(seller, perguntaId, texto);
      recordAudit(seller, "pergunta_respondida", `pergunta ${perguntaId}: "${texto.slice(0, 200)}"`);

      return ok(`Resposta publicada na pergunta ${perguntaId} (resposta ${res.id}):\n"${texto}"`, { answerId: res.id, perguntaId, texto });
    } catch (err) {
      return toErrorResult(err, "responder_pergunta");
    }
  },
};
