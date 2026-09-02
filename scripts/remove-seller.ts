import { deleteSeller, getSellerByName, recordAudit } from "../src/database/sellersRepo.js";

/**
 * Uso: npm run oauth:remove-seller -- nome_do_cliente
 *
 * Remove os tokens locais do seller. Isto NÃO revoga a permissão do lado do
 * Mercado Livre — o dono da conta pode (e deve, se for desligamento
 * definitivo) revogar em: Meus aplicativos > [app] > Administrar permissões,
 * ou o vendedor pode revogar diretamente nas configurações da conta dele.
 */
const sellerName = process.argv[2];

if (!sellerName) {
  console.error("Uso: npm run oauth:remove-seller -- nome_do_cliente");
  process.exit(1);
}

const existing = getSellerByName(sellerName);
if (!existing) {
  console.error(`Seller "${sellerName}" não encontrado.`);
  process.exit(1);
}

deleteSeller(sellerName);
recordAudit(sellerName, "seller_removed_locally");
console.log(`Seller "${sellerName}" removido do Enginne (tokens locais apagados).`);
console.log("Lembrete: isso não revoga o grant no lado do Mercado Livre automaticamente.");
