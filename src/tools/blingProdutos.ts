import { z } from "zod";
import { ok, errorResult, toErrorResult, type ToolDefinition } from "./types.js";
import { blingGet, blingPut } from "../bling/client.js";

interface BlingProduto extends Record<string, unknown> {
  id: number;
  nome: string;
  codigo?: string;
  preco?: number;
  situacao?: string;
}

function moneyBr(n: number | undefined): string {
  return n === undefined ? "(não informado)" : `R$ ${n.toFixed(2)}`;
}

function formatarProdutoCompleto(p: BlingProduto): string {
  return JSON.stringify(p, null, 2);
}

const consultarProdutoSchema = {
  seller: z.string().describe("Nome interno da conta Bling"),
  produtoId: z.string().describe("ID do produto no Bling"),
};

export const consultarProdutoBlingTool: ToolDefinition<typeof consultarProdutoSchema> = {
  name: "consultar_produto_bling",
  title: "Consultar produto (Bling)",
  description: "Detalha um produto específico cadastrado no Bling, com TODOS os campos disponíveis.",
  inputSchema: consultarProdutoSchema,
  handler: async ({ seller, produtoId }) => {
    try {
      const produto = await blingGet<{ data: BlingProduto }>(seller, `/produtos/${produtoId}`);
      const p = produto.data;
      return ok(`${p.nome} (ID ${p.id}) — todos os campos:\n\n${formatarProdutoCompleto(p)}`, { produto: p });
    } catch (err) {
      return toErrorResult(err, "consultar_produto_bling");
    }
  },
};

const listarProdutosSchema = {
  seller: z.string().describe("Nome interno da conta Bling"),
  pesquisa: z.string().optional().describe("Filtro por nome/código do produto (opcional)"),
  limite: z.number().int().positive().max(100).optional().describe("Máximo de produtos a retornar (default 50)"),
  detalhado: z
    .boolean()
    .optional()
    .describe("Se true, busca todos os campos de cada produto (mais lento). Default false: campos básicos."),
};

export const listarProdutosBlingTool: ToolDefinition<typeof listarProdutosSchema> = {
  name: "listar_produtos_bling",
  title: "Listar produtos (Bling)",
  description: "Lista produtos do Bling. Com detalhado=true, busca TODOS os campos de cada um.",
  inputSchema: listarProdutosSchema,
  handler: async ({ seller, pesquisa, limite, detalhado }) => {
    try {
      const resp = await blingGet<{ data: BlingProduto[] }>(seller, "/produtos", {
        criterio: pesquisa,
        limite: limite ?? 50,
      });

      if (!detalhado) {
        const linhas = resp.data.map(
          (p) => `- ${p.nome} (ID ${p.id}) | ${p.codigo ?? "sem código"} | ${moneyBr(p.preco)} | situação ${p.situacao ?? "?"}`
        );
        return ok(
          `${resp.data.length} produto(s) encontrado(s) (campos básicos — use detalhado=true para ver tudo):\n${linhas.join("\n")}`,
          { produtos: resp.data }
        );
      }

      const completos: BlingProduto[] = [];
      for (const item of resp.data) {
        const detalhe = await blingGet<{ data: BlingProduto }>(seller, `/produtos/${item.id}`);
        completos.push(detalhe.data);
      }

      const blocos = completos.map((p) => `${p.nome} (ID ${p.id}):\n${formatarProdutoCompleto(p)}`);
      return ok(`${completos.length} produto(s), com todos os campos:\n\n${blocos.join("\n\n---\n\n")}`, { produtos: completos });
    } catch (err) {
      return toErrorResult(err, "listar_produtos_bling");
    }
  },
};

const editarProdutoSchema = {
  seller: z.string().describe("Nome interno da conta Bling"),
  produtoId: z.string().describe("ID do produto a editar"),
  nome: z.string().min(1).optional().describe("Novo nome do produto (opcional)"),
  preco: z.number().positive().optional().describe("Novo preço (opcional)"),
  situacao: z.enum(["ativo", "inativo"]).optional().describe("Nova situação do produto (opcional)"),
  confirmar: z.boolean().optional().describe("Só aplica de fato quando true. Default false: mostra prévia."),
};

export const editarProdutoBlingTool: ToolDefinition<typeof editarProdutoSchema> = {
  name: "editar_produto_bling",
  title: "Editar produto (Bling)",
  description: "Edita nome, preço e/ou situação. Por padrão só mostra prévia — chame com confirmar=true para aplicar.",
  inputSchema: editarProdutoSchema,
  handler: async ({ seller, produtoId, nome, preco, situacao, confirmar }) => {
    try {
      const hasChange = [nome, preco, situacao].some((v) => v !== undefined);
      if (!hasChange) return errorResult("Informe ao menos um campo para alterar (nome, preco ou situacao).");

      const current = await blingGet<{ data: BlingProduto }>(seller, `/produtos/${produtoId}`);
      const p = current.data;

      const diffLines: string[] = [];
      if (nome !== undefined && nome !== p.nome) diffLines.push(`Nome: "${p.nome}" -> "${nome}"`);
      if (preco !== undefined && preco !== p.preco) diffLines.push(`Preço: ${moneyBr(p.preco)} -> ${moneyBr(preco)}`);
      const situacaoBling = situacao === "ativo" ? "Ativo" : situacao === "inativo" ? "Inativo" : undefined;
      if (situacaoBling !== undefined && situacaoBling !== p.situacao) diffLines.push(`Situação: ${p.situacao} -> ${situacaoBling}`);

      if (diffLines.length === 0) {
        return ok(`Nenhuma mudança real: os valores já são iguais aos atuais do produto ${produtoId}.`, { noop: true, current: p });
      }

      if (!confirmar) {
        return ok(
          `PRÉVIA — nada foi alterado ainda. Mudanças propostas no produto ${produtoId} (${p.nome}):\n\n${diffLines.join("\n")}\n\nChame de novo com confirmar=true para aplicar.`,
          { preview: true, diff: diffLines, current: p }
        );
      }

      const updated = await blingPut<{ data: BlingProduto }>(seller, `/produtos/${produtoId}`, {
        ...p,
        nome: nome ?? p.nome,
        preco: preco ?? p.preco,
        situacao: situacaoBling ?? p.situacao,
      });

      return ok(`Produto ${produtoId} atualizado:\n${diffLines.join("\n")}`, { produto: updated.data, applied: diffLines });
    } catch (err) {
      return toErrorResult(err, "editar_produto_bling");
    }
  },
};

const buscarSemNcmSchema = {
  seller: z.string().describe("Nome interno da conta Bling"),
  maxPaginas: z.number().int().positive().max(50).optional().describe("Máximo de páginas a varrer (100 produtos por página). Default 20."),
};

export const buscarProdutosSemNcmBlingTool: ToolDefinition<typeof buscarSemNcmSchema> = {
  name: "buscar_produtos_bling_sem_ncm",
  title: "Buscar produtos sem NCM (Bling)",
  description: "Varre o catálogo inteiro do Bling e retorna os produtos sem NCM cadastrado.",
  inputSchema: buscarSemNcmSchema,
  handler: async ({ seller, maxPaginas }) => {
    try {
      const limitePaginas = maxPaginas ?? 20;
      const semNcm: BlingProduto[] = [];
      let totalVarrido = 0;

      for (let pagina = 1; pagina <= limitePaginas; pagina++) {
        const resp = await blingGet<{ data: BlingProduto[] }>(seller, "/produtos", { pagina, limite: 100 });
        if (!resp.data || resp.data.length === 0) break;

        totalVarrido += resp.data.length;
        for (const p of resp.data) {
          let ncm = p.ncm as string | undefined;
          if (ncm === undefined) {
            const detalhe = await blingGet<{ data: BlingProduto }>(seller, `/produtos/${p.id}`);
            ncm = detalhe.data.ncm as string | undefined;
          }
          if (!ncm || String(ncm).trim() === "") semNcm.push(p);
        }

        if (resp.data.length < 100) break;
      }

      if (semNcm.length === 0) {
        return ok(`Nenhum produto sem NCM encontrado (${totalVarrido} produto(s) verificado(s)).`, { produtos: [], totalVarrido });
      }

      const linhas = semNcm.map((p) => `- ${p.nome} (ID ${p.id}) | código ${p.codigo ?? "sem código"}`);
      return ok(`${semNcm.length} produto(s) sem NCM, de ${totalVarrido} verificado(s):\n${linhas.join("\n")}`, {
        produtos: semNcm,
        totalVarrido,
      });
    } catch (err) {
      return toErrorResult(err, "buscar_produtos_bling_sem_ncm");
    }
  },
};
