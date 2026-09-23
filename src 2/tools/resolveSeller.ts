import { getSellerByName, type SellerRow } from "../database/sellersRepo.js";

export class ToolInputError extends Error {}

/** Resolve um nome de seller para o registro no banco, validando que já foi autorizado. */
export function resolveSeller(sellerName: string): SellerRow {
  const row = getSellerByName(sellerName);
  if (!row) {
    throw new ToolInputError(
      `Seller "${sellerName}" não encontrado. Use a tool listar_contas() para ver os nomes disponíveis.`
    );
  }
  // "error" NÃO bloqueia: é quase sempre uma falha temporária de renovação
  // (ex.: 429). A próxima chamada tenta renovar de novo e, se der certo,
  // o status volta sozinho para "active".
  if ((row.status !== "active" && row.status !== "error") || !row.ml_user_id) {
    throw new ToolInputError(
      `Seller "${sellerName}" está com status "${row.status}" (autorização OAuth pendente, expirada ou revogada). ` +
        `Peça ao administrador para reconectar essa conta.`
    );
  }
  return row;
}
