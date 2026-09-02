import { z } from "zod";
import { env } from "../config/env.js";
import { getDb } from "../database/db.js";
import { listSellers, getSellerByName, toPublic } from "../database/sellersRepo.js";
import { getValidAccessToken } from "../auth/tokenManager.js";
import { ok, type ToolDefinition } from "./types.js";

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
  try {
    const res = await fetch(`${env.ML_API_BASE_URL}/sites/MLB`, { method: "GET" });
    return { nome: "API Mercado Livre", ok: res.ok, detalhe: res.ok ? `HTTP ${res.status} (site MLB acessível)` : `HTTP ${res.status}` };
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
      ok: row.status === "active",
      detalhe: `status=${row.status}${row.ml_nickname ? `, nickname=${row.ml_nickname}` : ""}`,
    },
  ];
  if (row.status === "active") {
    try {
      await getValidAccessToken(sellerName);
      results.push({
        nome: `Token de "${sellerName}"`,
        ok: true,
        detalhe: `válido, expira em ${row.token_expires_at}, última renovação: ${row.last_refreshed_at ?? "n/d"}`,
      });
    } catch (err) {
      results.push({ nome: `Token de "${sellerName}"`, ok: false, detalhe: String(err) });
    }
  } else if (row.last_error) {
    results.push({ nome: `Último erro de "${sellerName}"`, ok: false, detalhe: row.last_error });
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
