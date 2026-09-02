import { listSellers, toPublic } from "../src/database/sellersRepo.js";

const sellers = listSellers().map(toPublic);

if (sellers.length === 0) {
  console.log("Nenhum seller configurado. Use: npm run oauth:add-seller -- nome_do_cliente");
  process.exit(0);
}

console.table(
  sellers.map((s) => ({
    seller: s.sellerName,
    status: s.status,
    ml_user_id: s.mlUserId ?? "",
    nickname: s.mlNickname ?? "",
    token_expira_em: s.tokenExpiresAt ?? "",
    autorizado_em: s.authorizedAt ?? "",
  }))
);
