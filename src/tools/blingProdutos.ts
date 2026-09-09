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
  nome: z.string().min(1).optional().describe("Novo nome/título do produto (opcional)"),
  preco: z.number().positive().optional().describe("Novo preço (opcional)"),
  situacao: z.enum(["ativo", "inativo"]).optional().describe("Nova situação do produto (opcional)"),
  ncm: z
    .string()
    .optional()
    .describe('Novo NCM (opcional), ex.: "3305.10.00". Passe string vazia "" para limpar o NCM cadastrado.'),
  gtin: z.string().optional().describe("Novo código de barras/EAN (GTIN) do produto (opcional)"),
  marca: z.string().optional().describe("Nova marca do produto (opcional)"),
  pesoLiquido: z.number().nonnegative().optional().describe("Novo peso líquido em kg (opcional)"),
  pesoBruto: z.number().nonnegative().optional().describe("Novo peso bruto em kg (opcional)"),
  largura: z.number().nonnegative().optional().describe("Nova largura em cm (opcional)"),
  altura: z.number().nonnegative().optional().describe("Nova altura em cm (opcional)"),
  profundidade: z.number().nonnegative().optional().describe("Nova profundidade/comprimento em cm (opcional)"),
  descricaoCurta: z.string().optional().describe("Nova descrição curta do produto (opcional) — substitui a atual inteira"),
  descricaoComplementar: z
    .string()
    .optional()
    .describe("Nova descrição complementar/detalhada do produto (opcional) — substitui a atual inteira"),
  camposExtras: z
    .record(z.unknown())
    .optional()
    .describe(
      "Qualquer outro campo aceito pela API do Bling em PUT /produtos/{id} que não tenha um parâmetro dedicado acima (ex.: {\"unidade\": \"CX\"} ou {\"tributacao\": {\"origem\": 1}}). Objetos são mesclados nível a nível com o produto atual, não sobrescrevem o objeto inteiro — exceto quando você mesmo passar um objeto aninhado completo. Use com cautela: não há prévia campo-a-campo para o conteúdo deste objeto além do JSON bruto mostrado na prévia."
    ),
  confirmar: z.boolean().optional().describe("Só aplica de fato quando true. Default false: mostra prévia."),
};

export const editarProdutoBlingTool: ToolDefinition<typeof editarProdutoSchema> = {
  name: "editar_produto_bling",
  title: "Editar produto (Bling)",
  description:
    "Edita nome, preço, situação, NCM, GTIN, marca, peso, dimensões, descrições e/ou qualquer outro campo do Bling (via camposExtras). Só altera os campos informados — os demais ficam como estão. Por padrão só mostra prévia — chame com confirmar=true para aplicar.",
  inputSchema: editarProdutoSchema,
  handler: async ({
    seller,
    produtoId,
    nome,
    preco,
    situacao,
    ncm,
    gtin,
    marca,
    pesoLiquido,
    pesoBruto,
    largura,
    altura,
    profundidade,
    descricaoCurta,
    descricaoComplementar,
    camposExtras,
    confirmar,
  }) => {
    try {
      const hasChange = [
        nome,
        preco,
        situacao,
        ncm,
        gtin,
        marca,
        pesoLiquido,
        pesoBruto,
        largura,
        altura,
        profundidade,
        descricaoCurta,
        descricaoComplementar,
        camposExtras,
      ].some((v) => v !== undefined);
      if (!hasChange) {
        return errorResult(
          "Informe ao menos um campo para alterar (nome, preco, situacao, ncm, gtin, marca, pesoLiquido, pesoBruto, largura, altura, profundidade, descricaoCurta, descricaoComplementar ou camposExtras)."
        );
      }

      const current = await blingGet<{ data: BlingProduto }>(seller, `/produtos/${produtoId}`);
      const p = current.data;
      const tributacaoAtual = (p.tributacao as Record<string, unknown> | undefined) ?? {};
      const dimensoesAtual = (p.dimensoes as Record<string, unknown> | undefined) ?? {};

      const diffLines: string[] = [];
      if (nome !== undefined && nome !== p.nome) diffLines.push(`Nome: "${p.nome}" -> "${nome}"`);
      if (preco !== undefined && preco !== p.preco) diffLines.push(`Preço: ${moneyBr(p.preco)} -> ${moneyBr(preco)}`);
      const situacaoBling = situacao === "ativo" ? "Ativo" : situacao === "inativo" ? "Inativo" : undefined;
      if (situacaoBling !== undefined && situacaoBling !== p.situacao) diffLines.push(`Situação: ${p.situacao} -> ${situacaoBling}`);
      if (ncm !== undefined && ncm !== tributacaoAtual.ncm) {
        diffLines.push(`NCM: "${(tributacaoAtual.ncm as string) || "(vazio)"}" -> "${ncm || "(vazio)"}"`);
      }
      if (gtin !== undefined && gtin !== p.gtin) diffLines.push(`GTIN: "${(p.gtin as string) || "(vazio)"}" -> "${gtin}"`);
      if (marca !== undefined && marca !== p.marca) diffLines.push(`Marca: "${(p.marca as string) || "(vazia)"}" -> "${marca}"`);
      if (pesoLiquido !== undefined && pesoLiquido !== p.pesoLiquido) diffLines.push(`Peso líquido: ${p.pesoLiquido ?? 0}kg -> ${pesoLiquido}kg`);
      if (pesoBruto !== undefined && pesoBruto !== p.pesoBruto) diffLines.push(`Peso bruto: ${p.pesoBruto ?? 0}kg -> ${pesoBruto}kg`);
      if (largura !== undefined && largura !== dimensoesAtual.largura) diffLines.push(`Largura: ${dimensoesAtual.largura ?? 0}cm -> ${largura}cm`);
      if (altura !== undefined && altura !== dimensoesAtual.altura) diffLines.push(`Altura: ${dimensoesAtual.altura ?? 0}cm -> ${altura}cm`);
      if (profundidade !== undefined && profundidade !== dimensoesAtual.profundidade)
        diffLines.push(`Profundidade: ${dimensoesAtual.profundidade ?? 0}cm -> ${profundidade}cm`);
      if (descricaoCurta !== undefined) diffLines.push(`Descrição curta: substituída (${descricaoCurta.length} caractere(s) novo(s))`);
      if (descricaoComplementar !== undefined)
        diffLines.push(`Descrição complementar: substituída (${descricaoComplementar.length} caractere(s) novo(s))`);
      if (camposExtras !== undefined) diffLines.push(`Campos extras: ${JSON.stringify(camposExtras)}`);

      if (diffLines.length === 0) {
        return ok(`Nenhuma mudança real: os valores já são iguais aos atuais do produto ${produtoId}.`, { noop: true, current: p });
      }

      if (!confirmar) {
        return ok(
          `PRÉVIA — nada foi alterado ainda. Mudanças propostas no produto ${produtoId} (${p.nome}):\n\n${diffLines.join("\n")}\n\nChame de novo com confirmar=true para aplicar.`,
          { preview: true, diff: diffLines, current: p }
        );
      }

      const payload: Record<string, unknown> = {
        ...p,
        nome: nome ?? p.nome,
        preco: preco ?? p.preco,
        situacao: situacaoBling ?? p.situacao,
        gtin: gtin ?? p.gtin,
        marca: marca ?? p.marca,
        pesoLiquido: pesoLiquido ?? p.pesoLiquido,
        pesoBruto: pesoBruto ?? p.pesoBruto,
        descricaoCurta: descricaoCurta ?? p.descricaoCurta,
        descricaoComplementar: descricaoComplementar ?? p.descricaoComplementar,
        tributacao: {
          ...tributacaoAtual,
          ncm: ncm ?? tributacaoAtual.ncm,
        },
        dimensoes: {
          ...dimensoesAtual,
          largura: largura ?? dimensoesAtual.largura,
          altura: altura ?? dimensoesAtual.altura,
          profundidade: profundidade ?? dimensoesAtual.profundidade,
        },
        ...camposExtras,
      };

      const updated = await blingPut<{ data: BlingProduto }>(seller, `/produtos/${produtoId}`, payload);

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
