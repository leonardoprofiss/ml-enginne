import { z } from "zod";
import { listSellers, getSellerByName, toPublic } from "../database/sellersRepo.js";
import { getMe } from "../mercadolivre/endpoints.js";
import { ok, toErrorResult, type ToolDefinition } from "./types.js";

export const listarContasTool: ToolDefinition<{}> = {
  name: "listar_contas",
  title: "Listar contas conectadas",
  description:
    "Lista todos os sellers (contas do Mercado Livre) atualmente configurados no Enginne, com status da autorização OAuth de cada um (pending, active, expired, revoked, error). Use antes de qualquer outra análise para saber quais nomes de seller estão disponíveis.",
  inputSchema: {},
  handler: async () => {
    const sellers = listSellers().map(toPublic);
    if (sellers.length === 0) {
      return ok(
        "Nenhum seller configurado ainda. Peça ao administrador para rodar `npm run oauth:add-seller -- <nome>` para conectar a primeira conta."
      );
    }
    const lines = sellers.map((s) => {
      const parts = [
        `- ${s.sellerName}`,
        `status: ${s.status}`,
        s.mlNickname ? `nickname ML: ${s.mlNickname}` : undefined,
        s.mlUserId ? `user_id: ${s.mlUserId}` : undefined,
        s.tokenExpiresAt ? `token expira em: ${s.tokenExpiresAt}` : undefined,
      ].filter(Boolean);
      return parts.join(" | ");
    });
    return ok(`Contas configuradas (${sellers.length}):\n${lines.join("\n")}`, { sellers });
  },
};

const consultarSellerSchema = {
  seller: z.string().describe("Nome interno do seller, conforme retornado por listar_contas()"),
};

export const consultarSellerTool: ToolDefinition<typeof consultarSellerSchema> = {
  name: "consultar_seller",
  title: "Consultar dados da conta",
  description:
    "Retorna dados detalhados de uma conta do Mercado Livre: nickname, data de registro, país, reputação resumida e status do site. Faz uma chamada em tempo real à API (GET /users/{id}).",
  inputSchema: consultarSellerSchema,
  handler: async ({ seller }) => {
    const row = getSellerByName(seller);
    if (!row) return toErrorResult(new Error(`Seller "${seller}" não encontrado`), "consultar_seller");
    try {
      const me = await getMe(seller);
      return ok(
        `Conta ${seller}: ${me.nickname} (ML user_id ${me.id})\n` +
          `País: ${me.country_id} | Cadastro: ${me.registration_date}\n` +
          `Reputação: nível ${me.seller_reputation?.level_id ?? "n/d"}, power seller: ${
            me.seller_reputation?.power_seller_status ?? "não"
          }\n` +
          `Transações: ${me.seller_reputation?.transactions?.total ?? 0} totais (${
            me.seller_reputation?.transactions?.completed ?? 0
          } concluídas, ${me.seller_reputation?.transactions?.canceled ?? 0} canceladas)\n` +
          `Status do site: ${me.status?.site_status ?? "n/d"}`,
        { seller: me }
      );
    } catch (err) {
      return toErrorResult(err, "consultar_seller");
    }
  },
};
