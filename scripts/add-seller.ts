import { env } from "../src/config/env.js";
import { ensureSellerPlaceholder } from "../src/database/sellersRepo.js";

/**
 * Uso: npm run oauth:add-seller -- nome_do_cliente
 *
 * Isto NÃO faz a autorização sozinho (login/consentimento é uma etapa
 * humana, obrigatória, no navegador). Este script apenas:
 *  1. Cria o registro "pending" do seller no banco.
 *  2. Imprime a URL que um humano (o dono da conta do Mercado Livre) deve
 *     abrir no navegador para autorizar o Enginne.
 */
const sellerName = process.argv[2];

if (!sellerName || !/^[a-z0-9_-]+$/i.test(sellerName)) {
  console.error("Uso: npm run oauth:add-seller -- nome_do_cliente (apenas letras, números, - e _)");
  process.exit(1);
}

ensureSellerPlaceholder(sellerName);

const startUrl = new URL("/oauth/start", env.PUBLIC_BASE_URL);
startUrl.searchParams.set("seller", sellerName);

console.log(`\nSeller "${sellerName}" criado (status: pending).`);
console.log(`\nPara concluir, envie este link para a pessoa DONA da conta do Mercado Livre "${sellerName}" abrir e autorizar:\n`);
console.log(`  ${startUrl.toString()}\n`);
console.log("O servidor Enginne (PUBLIC_BASE_URL) precisa estar rodando e acessível para este link funcionar.");
console.log("Depois de autorizado, rode `npm run oauth:list-sellers` para confirmar o status = active.\n");
