import { z } from "zod";
import { ok, errorResult, toErrorResult, type ToolDefinition } from "./types.js";
import { blingGet, blingPut } from "../bling/client.js";

interface BlingProduto {
  id: number;
  nome: string;
  codigo?: string;
  preco?: number;
  situacao?: string;
  estoque?: { saldoVirtualTotal?: number };
}

function moneyBr(n: number | undefined): string {
  return n === undefined ? "(não informado)" : `R$ ${n.toFixed(2)}`;
}

const consultarProdutoSchema = {
  seller: z.string().describe("Nome interno da conta Bling"),
  produtoId: z.string().describe("ID do produto no Bling"),
};

export const consultarProdutoBlingTool: ToolDefinition<typeof consultarProdutoSchema> = {
  name: "consultar_produto_bling",
  title: "Consultar produto (Bling)",
  description: "Detalha um produto específico cadastrado no Bling.",
  inputSchema: consultarProdutoSchema,
  handler: async ({ seller, produtoId }) => {
    try {
      const produto = await blingGet<{ data: BlingProduto }>(seller, `/produtos/${produtoId}`);
      const p = produto.data;
      return ok(
        `${p.nome} (ID ${p.id})\nCódigo: ${p.codigo ?? "(sem código)"} | Preço: ${moneyBr(p.preco)} | Situação: ${p.situacao ?? "?"} | Estoque: ${p.estoque?.saldoVirtualTotal ?? "?"}`,
        { produto: p }
      );
    } catch (err) {
      return toErrorResult(err, "consultar_produto_bling");
    }
  },
};

const listarProdutosSchema = {
  seller: z.string().describe("Nome interno da conta Bling"),
  pesquisa: z.string().optional().describe("Filtro por nome/código do produto (opcional)"),
  limite: z.number().int().positive().max(100).optional().describe("Máximo de produtos a retornar (default 50)"),
};

export const listarProdutosBlingTool: ToolDefinition<typeof listarProdutosSchema> = {
  name: "listar_produtos_bling",
  title: "Listar produtos (Bling)",
  description: "Lista produtos cadastrados no Bling.",
  inputSchema: listarProdutosSchema,
  handler: async ({ seller, pesquisa, limite }) => {
    try {
      const resp = await blingGet<{ data: BlingProduto[] }>(seller, "/produtos", {
        criterio: pesquisa,
        limite: limite ?? 50,
      });
      const linhas = resp.data.map(
        (p) => `- ${p.nome} (ID ${p.id}) | ${p.codigo ?? "sem código"} | ${moneyBr(p.preco)} | estoque ${p.estoque?.saldoVirtualTotal ?? "?"}`
      );
      return ok(`${resp.data.length} produto(s) encontrado(s):\n${linhas.join("\n")}`, { produtos: resp.data });
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
  description: "Edita nome, preço e/ou situação de um produto existente no Bling. Por padrão só mostra prévia — chame com confirmar=true para aplicar.",
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
