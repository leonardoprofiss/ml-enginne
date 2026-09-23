import { z } from "zod";
import { env } from "../config/env.js";
import { getDb } from "../database/db.js";
import { listSellers, getSellerByName, toPublic } from "../database/sellersRepo.js";
import { getValidAccessToken } from "../auth/tokenManager.js";
import { ok, type ToolDefinition } from "./types.js";
import { mlGet } from "../mercadolivre/client.js";
import { listAdvertisers } from "../mercadolivre/advertisingEndpoints.js";

const diagSchema = {
  seller: z
    .string()
    .optional()
    .describe("Nome interno de um seller específico para testar o token dele. Se omitido, testa apenas a saúde geral."),
};

interface CheckResult {
  nome: string;
  ok: boolean;
  detalhe: string;
}

async function checkMlApi(): Promise<CheckResult> {
  // Chamadas anônimas a partir de IPs de nuvem (Railway, Google Cloud) recebem
  // 403 do Mercado Livre por política deles — isso NÃO indica problema na
  // integração. Por isso o teste de verdade é o autenticado, em checkSeller.
  try {
    const res = await fetch(`${env.ML_API_BASE_URL}/sites/MLB`, { method: "GET" });
    if (res.ok) return { nome: "API Mercado Livre (anônima)", ok: true, detalhe: `HTTP ${res.status}` };
    return {
      nome: "API Mercado Livre (anônima)",
      ok: true,
      detalhe: `HTTP ${res.status} — esperado para chamadas sem token a partir de servidores em nuvem; o teste que vale é o autenticado por seller`,
    };
  } catch (err) {
    return { nome: "API Mercado Livre", ok: false, detalhe: `Falha de rede: ${String(err)}` };
  }
}

function checkOAuthConfig(): CheckResult {
  const hasClientId = Boolean(env.ML_CLIENT_ID);
  const hasSecret = Boolean(env.ML_CLIENT_SECRET);
  return {
    nome: "Configuração OAuth",
    ok: hasClientId && hasSecret,
    detalhe: hasClientId && hasSecret ? "ML_CLIENT_ID e ML_CLIENT_SECRET presentes" : "credenciais ausentes no ambiente",
  };
}

function checkDb(): CheckResult {
  try {
    getDb().prepare("SELECT 1").get();
    return { nome: "Banco de dados", ok: true, detalhe: `SQLite OK (${env.DATABASE_PATH})` };
  } catch (err) {
    return { nome: "Banco de dados", ok: false, detalhe: String(err) };
  }
}

function checkMcp(): CheckResult {
  // Se este handler está executando, o servidor MCP está de pé e respondendo.
  return { nome: "Servidor MCP", ok: true, detalhe: "processo ativo e respondendo a chamadas de tool" };
}

async function checkSeller(sellerName: string): Promise<CheckResult[]> {
  const row = getSellerByName(sellerName);
  if (!row) {
    return [{ nome: `Seller "${sellerName}"`, ok: false, detalhe: "não encontrado no banco" }];
  }
  const results: CheckResult[] = [
    {
      nome: `Seller "${sellerName}"`,
      ok: row.status === "active" || row.status === "error",
      detalhe: `status=${row.status}${row.ml_nickname ? `, nickname=${row.ml_nickname}` : ""}${row.last_error ? `, último erro: ${row.last_error}` : ""}`,
    },
  ];
  if (row.status === "revoked" || row.status === "pending") return results;

  try {
    await getValidAccessToken(sellerName);
    const fresh = getSellerByName(sellerName)!;
    results.push({
      nome: `Token de "${sellerName}"`,
      ok: true,
      detalhe: `válido até ${fresh.token_expires_at}; última renovação ${fresh.last_refreshed_at ?? "n/d"}; escopos: ${fresh.scope ?? "n/d"}`,
    });
  } catch (err) {
    results.push({ nome: `Token de "${sellerName}"`, ok: false, detalhe: String(err) });
    return results;
  }

  try {
    const me = await mlGet<{ id: number; nickname: string; seller_reputation?: { level_id?: string; power_seller_status?: string } }>(sellerName, "/users/me");
    const rep = me.seller_reputation;
    results.push({
      nome: "Chamada autenticada (/users/me)",
      ok: true,
      detalhe: `${me.nickname} (id ${me.id})${rep ? `, reputação ${rep.level_id ?? "n/d"}${rep.power_seller_status ? `, MercadoLíder ${rep.power_seller_status}` : ""}` : ""}`,
    });
  } catch (err) {
    results.push({ nome: "Chamada autenticada (/users/me)", ok: false, detalhe: String(err) });
  }

  try {
    const adv = await listAdvertisers(sellerName, "PADS");
    results.push({
      nome: "Product Ads",
      ok: true,
      detalhe: adv.length ? adv.map((a) => `advertiser ${a.advertiser_id} (${a.site_id})`).join(", ") : "conta sem Product Ads habilitado",
    });
  } catch (err) {
    results.push({ nome: "Product Ads", ok: false, detalhe: String(err) });
  }
  return results;
}

export const diagnosticarIntegracaoTool: ToolDefinition<typeof diagSchema> = {
  name: "diagnosticar_integracao",
  title: "Diagnosticar integração",
  description:
    "Roda uma checagem de saúde completa do Enginne: conectividade com a API do Mercado Livre, configuração OAuth, banco de dados, servidor MCP e (se um seller for informado) validade do token daquele seller. Use para investigar problemas antes de reportar um bug.",
  inputSchema: diagSchema,
  handler: async ({ seller }) => {
    const checks: CheckResult[] = [checkMcp(), checkOAuthConfig(), checkDb(), await checkMlApi()];

    if (seller) {
      checks.push(...(await checkSeller(seller)));
    } else {
      const sellers = listSellers();
      const active = sellers.filter((s) => s.status === "active").length;
      checks.push({
        nome: "Sellers configurados",
        ok: sellers.length > 0,
        detalhe: `${sellers.length} total, ${active} ativos`,
      });
    }

    const allOk = checks.every((c) => c.ok);
    const lines = checks.map((c) => `${c.ok ? "OK" : "FALHA"} — ${c.nome}: ${c.detalhe}`);

    return ok(`Diagnóstico do Enginne (${allOk ? "tudo OK" : "há problemas"}):\n${lines.join("\n")}`, {
      allOk,
      checks,
      sellers: seller ? undefined : listSellers().map(toPublic),
    });
  },
};
