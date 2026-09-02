import { getValidAccessToken } from "../src/auth/tokenManager.js";
import { getSellerByName } from "../src/database/sellersRepo.js";

/**
 * Uso: npm run oauth:renew-seller -- nome_do_cliente
 * Força a checagem/renovação do access_token (útil depois de um erro).
 * Se o refresh_token também estiver expirado/revogado (6 meses sem uso, ou
 * revogação manual), isso vai falhar — nesse caso é necessário refazer o
 * fluxo completo com `npm run oauth:add-seller -- nome_do_cliente`.
 */
const sellerName = process.argv[2];

if (!sellerName) {
  console.error("Uso: npm run oauth:renew-seller -- nome_do_cliente");
  process.exit(1);
}

if (!getSellerByName(sellerName)) {
  console.error(`Seller "${sellerName}" não encontrado.`);
  process.exit(1);
}

try {
  await getValidAccessToken(sellerName);
  const row = getSellerByName(sellerName)!;
  console.log(`OK — token de "${sellerName}" válido até ${row.token_expires_at}.`);
} catch (err) {
  console.error(`Falha ao renovar "${sellerName}":`, err instanceof Error ? err.message : err);
  console.error(`Se o refresh_token expirou/foi revogado, refaça: npm run oauth:add-seller -- ${sellerName}`);
  process.exit(1);
}
