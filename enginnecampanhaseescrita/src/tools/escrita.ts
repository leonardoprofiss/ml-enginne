import { z } from "zod";
import { resolveSeller } from "./resolveSeller.js";
import { ok, errorResult, toErrorResult, type ToolDefinition } from "./types.js";
import { getItem } from "../mercadolivre/endpoints.js";
import { createItem, updateItem } from "../mercadolivre/itemsWrite.js";
import { recordAudit } from "../database/sellersRepo.js";

/**
 * Tools de ESCRITA (V2) — criam e editam anúncios de verdade no Mercado
 * Livre. Diferente de toda a V1 (só leitura), essas tools têm efeito real e
 * irreversível por API (não existe "desfazer" um anúncio criado; editar um
 * campo sobrescreve o valor anterior).
 *
 * Padrão de segurança adotado em ambas: confirmação em duas etapas.
 * `confirmar` tem default `false` — sem ele, a tool só devolve uma PRÉVIA
 * do que seria feito, sem chamar a API de escrita da ML. Só quando chamada
 * de novo com `confirmar: true` a mudança é executada. Isso existe para que
 * o Claude (ou quem estiver conversando) sempre mostre a prévia para a
 * pessoa antes de agir — nunca crie/edite um anúncio de primeira, numa
 * única mensagem, sem o usuário ver exatamente o que vai mudar.
 *
 * Toda execução (confirmar=true) é registrada em audit_log via recordAudit.
 */

function moneyBr(n: number): string {
  return `R$ ${n.toFixed(2)}`;
}

// ---- criar_anuncio ----

const criarAnuncioSchema = {
  seller: z.string().describe("Nome interno do seller (ver listar_contas)"),
  titulo: z.string().min(1).max(60).describe("Título do anúncio (a ML costuma limitar a 60 caracteres)"),
  categoriaId: z.string().describe("ID da categoria ML (ex.: MLB1051). Descubra via app.mercadolivre.com.br ou o preditor de categoria da API."),
  preco: z.number().positive().describe("Preço de venda (mesma moeda da conta, normalmente BRL)"),
  quantidade: z.number().int().nonnegative().describe("Quantidade disponível em estoque"),
  tipoAnuncio: z
    .string()
    .describe(
      'listing_type_id do anúncio (ex.: "gold_special", "gold_pro") — varia por categoria e pelo plano de anúncios da conta. Não há default proposital: escolher o tipo errado muda o custo do anúncio para o vendedor.'
    ),
  condicao: z.enum(["novo", "usado"]).optional().describe("Condição do produto. Default: novo."),
  descricao: z.string().optional().describe("Texto da descrição do anúncio"),
  fotos: z.array(z.string().url()).optional().describe("URLs públicas (https) das fotos do produto"),
  atributos: z
    .array(z.object({ id: z.string(), valor: z.string() }))
    .optional()
    .describe(
      "Atributos exigidos pela categoria (ex.: marca, modelo, voltagem), como pares {id, valor}. Muitas categorias da ML exigem atributos específicos — se faltar algum obrigatório, a ML retorna erro citando qual (a mensagem de erro desta tool repassa esse detalhe)."
    ),
  confirmar: z
    .boolean()
    .optional()
    .describe(
      "Só cria o anúncio de fato quando true. Default false: nesse caso a tool apenas mostra uma prévia do que seria criado, sem chamar a API de escrita."
    ),
};

export const criarAnuncioTool: ToolDefinition<typeof criarAnuncioSchema> = {
  name: "criar_anuncio",
  title: "Criar anúncio",
  description:
    "Cria um novo anúncio (item) no Mercado Livre para o seller informado. AÇÃO REAL E IRREVERSÍVEL por padrão só roda em modo prévia — chame de novo com confirmar=true depois de mostrar a prévia para o usuário e ele concordar.",
  inputSchema: criarAnuncioSchema,
  handler: async ({ seller, titulo, categoriaId, preco, quantidade, tipoAnuncio, condicao, descricao, fotos, atributos, confirmar }) => {
    try {
      resolveSeller(seller);

      const previewLines = [
        `Título: ${titulo}`,
        `Categoria: ${categoriaId}`,
        `Preço: ${moneyBr(preco)}`,
        `Estoque inicial: ${quantidade}`,
        `Tipo de anúncio: ${tipoAnuncio}`,
        `Condição: ${condicao ?? "novo"}`,
        descricao ? `Descrição: ${descricao.slice(0, 200)}${descricao.length > 200 ? "..." : ""}` : `Descrição: (nenhuma)`,
        fotos && fotos.length > 0 ? `Fotos: ${fotos.length} imagem(ns)` : `Fotos: (nenhuma)`,
        atributos && atributos.length > 0 ? `Atributos: ${atributos.map((a) => `${a.id}=${a.valor}`).join(", ")}` : `Atributos: (nenhum)`,
      ];

      if (!confirmar) {
        return ok(
          `PRÉVIA — nada foi criado ainda. Isto vai criar um anúncio novo para ${seller}:\n\n${previewLines.join("\n")}\n\n` +
            `Se estiver correto, chame criar_anuncio novamente com os mesmos dados e confirmar=true para publicar de verdade.`,
          { preview: true, wouldCreate: { seller, titulo, categoriaId, preco, quantidade, tipoAnuncio, condicao, descricao, fotos, atributos } }
        );
      }

      const { item, descriptionError } = await createItem(seller, {
        title: titulo,
        category_id: categoriaId,
        price: preco,
        available_quantity: quantidade,
        listing_type_id: tipoAnuncio,
        condition: condicao === "usado" ? "used" : "new",
        description: descricao,
        pictures: fotos,
        attributes: atributos?.map((a) => ({ id: a.id, value_name: a.valor })),
      });

      recordAudit(seller, "anuncio_criado", `${item.id} "${titulo}" categoria=${categoriaId} preço=${moneyBr(preco)}`);

      const warn = descriptionError
        ? `\n\nATENÇÃO: o anúncio foi criado, mas a descrição falhou ao salvar (${descriptionError}). Use editar_anuncio para tentar de novo só a descrição.`
        : "";

      return ok(`Anúncio criado: ${item.id} — ${item.title}\nLink: ${item.permalink}${warn}`, { item, descriptionError });
    } catch (err) {
      return toErrorResult(err, "criar_anuncio");
    }
  },
};

// ---- editar_anuncio ----

const editarAnuncioSchema = {
  seller: z.string().describe("Nome interno do seller"),
  mlb: z.string().describe("ID do anúncio a editar, ex: MLB1234567890"),
  titulo: z.string().min(1).max(60).optional().describe("Novo título (opcional)"),
  preco: z.number().positive().optional().describe("Novo preço (opcional)"),
  estoque: z.number().int().nonnegative().optional().describe("Nova quantidade em estoque (opcional)"),
  status: z.enum(["ativo", "pausado"]).optional().describe("Novo status do anúncio (opcional) — ativo republica, pausado tira de circulação sem apagar."),
  descricao: z.string().optional().describe("Novo texto de descrição (opcional) — substitui a descrição atual inteira"),
  confirmar: z
    .boolean()
    .optional()
    .describe(
      "Só aplica a edição de fato quando true. Default false: nesse caso a tool mostra uma prévia comparando valor atual -> novo valor, sem alterar nada."
    ),
};

export const editarAnuncioTool: ToolDefinition<typeof editarAnuncioSchema> = {
  name: "editar_anuncio",
  title: "Editar anúncio",
  description:
    "Edita título, preço, estoque, status (ativo/pausado) e/ou descrição de um anúncio existente. Só altera os campos informados — os demais ficam como estão. AÇÃO REAL sobre o anúncio: por padrão só mostra uma prévia (atual -> novo) — chame de novo com confirmar=true para aplicar.",
  inputSchema: editarAnuncioSchema,
  handler: async ({ seller, mlb, titulo, preco, estoque, status, descricao, confirmar }) => {
    try {
      resolveSeller(seller);

      const hasChange = [titulo, preco, estoque, status, descricao].some((v) => v !== undefined);
      if (!hasChange) {
        return errorResult("Informe ao menos um campo para alterar (titulo, preco, estoque, status ou descricao).");
      }

      const current = await getItem(seller, mlb);

      const diffLines: string[] = [];
      if (titulo !== undefined && titulo !== current.title) diffLines.push(`Título: "${current.title}" -> "${titulo}"`);
      if (preco !== undefined && preco !== current.price) diffLines.push(`Preço: ${moneyBr(current.price)} -> ${moneyBr(preco)}`);
      if (estoque !== undefined && estoque !== current.available_quantity)
        diffLines.push(`Estoque: ${current.available_quantity} -> ${estoque}`);
      const statusMl = status === "ativo" ? "active" : status === "pausado" ? "paused" : undefined;
      if (statusMl !== undefined && statusMl !== current.status) diffLines.push(`Status: ${current.status} -> ${statusMl}`);
      if (descricao !== undefined) diffLines.push(`Descrição: substituída (${descricao.length} caractere(s) novo(s))`);

      if (diffLines.length === 0) {
        return ok(`Nenhuma mudança real: os valores informados já são iguais aos atuais de ${mlb}.`, { noop: true, current });
      }

      if (!confirmar) {
        return ok(
          `PRÉVIA — nada foi alterado ainda. Mudanças propostas em ${mlb} (${current.title}):\n\n${diffLines.join("\n")}\n\n` +
            `Se estiver correto, chame editar_anuncio novamente com os mesmos dados e confirmar=true para aplicar de verdade.`,
          { preview: true, diff: diffLines, current }
        );
      }

      const updated = await updateItem(seller, mlb, {
        title: titulo,
        price: preco,
        available_quantity: estoque,
        status: statusMl,
        description: descricao,
      });

      recordAudit(seller, "anuncio_editado", `${mlb}: ${diffLines.join(" | ")}`);

      return ok(`Anúncio ${mlb} atualizado:\n${diffLines.join("\n")}\n\nEstado atual: R$ ${updated.price} | estoque ${updated.available_quantity} | status ${updated.status}`, {
        item: updated,
        applied: diffLines,
      });
    } catch (err) {
      return toErrorResult(err, "editar_anuncio");
    }
  },
};
