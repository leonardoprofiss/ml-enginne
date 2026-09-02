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
  if (row.status !== "active" || !row.ml_user_id) {
    throw new ToolInputError(
      `Seller "${sellerName}" está com status "${row.status}" (autorização OAuth pendente, expirada ou revogada). ` +
        `Peça ao administrador para reconectar essa conta.`
    );
  }
  return row;
}
