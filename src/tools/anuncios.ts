import { z } from "zod";
import { resolveSeller } from "./resolveSeller.js";
import { ok, toErrorResult, type ToolDefinition } from "./types.js";
import { searchAllItemIds, getItemsMultiget, getItem, getItemDescription } from "../mercadolivre/endpoints.js";

const sellerSchema = { seller: z.string().describe("Nome interno do seller (ver listar_contas)") };

const limitSchema = {
  ...sellerSchema,
  status: z
    .enum(["active", "paused", "closed", "under_review", "todos"])
    .optional()
    .describe('Filtrar por status do anúncio. Default: "active".'),
  limite: z.number().int().positive().max(2000).optional().describe("Máximo de anúncios a retornar (default 100)."),
};

export const listarAnunciosTool: ToolDefinition<typeof limitSchema> = {
  name: "listar_anuncios",
  title: "Listar anúncios",
  description:
    "Lista os anúncios (MLBs) de um seller, com título, preço, estoque disponível, vendas acumuladas e status. Suporta contas grandes via paginação por scroll — não traz tudo de uma vez se `limite` não for informado (default 100).",
  inputSchema: limitSchema,
  handler: async ({ seller, status, limite }) => {
    try {
      const row = resolveSeller(seller);
      const max = limite ?? 100;
      const allIds = await searchAllItemIds(seller, row.ml_user_id!, max);
      const items = await getItemsMultiget(seller, allIds);
      const filtered = status && status !== "todos" ? items.filter((i) => i.status === status) : items;

      const lines = filtered
        .slice(0, max)
        .map(
          (i) =>
            `- ${i.id} | ${i.title} | R$ ${i.price} | estoque: ${i.available_quantity} | vendidos: ${i.sold_quantity} | status: ${i.status}`
        );

      return ok(
        `${filtered.length} anúncio(s) encontrado(s) para ${seller}${status ? ` (status=${status})` : ""}:\n${lines.join("\n")}`,
        { items: filtered }
      );
    } catch (err) {
      return toErrorResult(err, "listar_anuncios");
    }
  },
};

const itemSchema = {
  seller: z.string().describe("Nome interno do seller"),
  mlb: z.string().describe("ID do anúncio no Mercado Livre, ex: MLB1234567890"),
};

export const consultarAnuncioTool: ToolDefinition<typeof itemSchema> = {
  name: "consultar_anuncio",
  title: "Consultar anúncio",
  description: "Detalha um anúncio específico (título, preço, estoque, categoria, atributos, descrição e link).",
  inputSchema: itemSchema,
  handler: async ({ seller, mlb }) => {
    try {
      resolveSeller(seller);
      const [item, description] = await Promise.all([
        getItem(seller, mlb),
        getItemDescription(seller, mlb).catch(() => ({ plain_text: "" })),
      ]);
      return ok(
        `${item.id} — ${item.title}\n` +
          `Preço: R$ ${item.price} | Estoque: ${item.available_quantity} | Vendidos: ${item.sold_quantity}\n` +
          `Status: ${item.status} | Categoria: ${item.category_id} | Tipo de anúncio: ${item.listing_type_id}\n` +
          `Frete grátis: ${item.shipping?.free_shipping ? "sim" : "não"}\n` +
          `Link: ${item.permalink}\n` +
          `Descrição: ${description.plain_text.slice(0, 500)}${description.plain_text.length > 500 ? "..." : ""}`,
        { item, description: description.plain_text }
      );
    } catch (err) {
      return toErrorResult(err, "consultar_anuncio");
    }
  },
};

export const consultarStatusAnuncioTool: ToolDefinition<typeof itemSchema> = {
  name: "consultar_status_anuncio",
  title: "Consultar status do anúncio",
  description:
    "Retorna apenas o status atual de um anúncio (active, paused, closed, under_review) — mais leve que consultar_anuncio quando só o status importa.",
  inputSchema: itemSchema,
  handler: async ({ seller, mlb }) => {
    try {
      resolveSeller(seller);
      const item = await getItem(seller, mlb);
      return ok(`${item.id} está com status: ${item.status}`, { id: item.id, status: item.status, health: item.health });
    } catch (err) {
      return toErrorResult(err, "consultar_status_anuncio");
    }
  },
};

export const consultarEstoqueTool: ToolDefinition<typeof itemSchema> = {
  name: "consultar_estoque",
  title: "Consultar estoque",
  description: "Retorna a quantidade disponível em estoque de um anúncio específico.",
  inputSchema: itemSchema,
  handler: async ({ seller, mlb }) => {
    try {
      resolveSeller(seller);
      const item = await getItem(seller, mlb);
      return ok(`${item.id} (${item.title}): ${item.available_quantity} unidades em estoque.`, {
        id: item.id,
        available_quantity: item.available_quantity,
      });
    } catch (err) {
      return toErrorResult(err, "consultar_estoque");
    }
  },
};

export const consultarPrecoTool: ToolDefinition<typeof itemSchema> = {
  name: "consultar_preco",
  title: "Consultar preço",
  description: "Retorna o preço atual de um anúncio específico.",
  inputSchema: itemSchema,
  handler: async ({ seller, mlb }) => {
    try {
      resolveSeller(seller);
      const item = await getItem(seller, mlb);
      return ok(`${item.id} (${item.title}): R$ ${item.price} ${item.currency_id}`, {
        id: item.id,
        price: item.price,
        currency_id: item.currency_id,
      });
    } catch (err) {
      return toErrorResult(err, "consultar_preco");
    }
  },
};
