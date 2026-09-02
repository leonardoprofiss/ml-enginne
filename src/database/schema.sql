-- Schema do Enginne. SQLite por padrão (arquivo único, ótimo para 1 instância).
-- Para múltiplas instâncias/alta disponibilidade, migrar para Postgres mantendo
-- o mesmo shape de tabelas (ver README > "Escalando para Postgres").

CREATE TABLE IF NOT EXISTS sellers (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  seller_name         TEXT NOT NULL UNIQUE,     -- nome interno do cliente, ex: "moncloa"
  ml_user_id          TEXT UNIQUE,               -- user_id retornado pelo Mercado Livre (preenchido após o grant)
  ml_nickname         TEXT,                      -- nickname da conta ML (cache, atualizado via consultar_seller)
  access_token_enc    TEXT,                      -- cifrado (AES-256-GCM) — nunca texto plano
  refresh_token_enc   TEXT,                      -- cifrado (AES-256-GCM) — nunca texto plano
  scope               TEXT,                      -- escopos concedidos, ex: "offline_access read"
  token_expires_at    TEXT,                      -- ISO 8601 (UTC)
  authorized_at       TEXT,                      -- ISO 8601 (UTC) — data da autorização OAuth inicial
  status               TEXT NOT NULL DEFAULT 'pending', -- pending | active | expired | revoked | error
  last_refreshed_at   TEXT,
  last_error          TEXT,
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Estado efêmero do fluxo OAuth (state + PKCE) entre /oauth/start e /oauth/callback.
CREATE TABLE IF NOT EXISTS oauth_pending (
  state               TEXT PRIMARY KEY,
  seller_name         TEXT NOT NULL,
  code_verifier        TEXT NOT NULL,
  redirect_uri         TEXT NOT NULL,
  created_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  expires_at            TEXT NOT NULL
);

-- Log de auditoria leve (sem payloads sensíveis) para diagnóstico e segurança.
CREATE TABLE IF NOT EXISTS audit_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  seller_name   TEXT,
  event         TEXT NOT NULL,        -- ex: oauth_authorized, token_refreshed, tool_call, error
  detail        TEXT,                 -- texto curto, nunca token/segredo
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_audit_log_seller ON audit_log(seller_name);
CREATE INDEX IF NOT EXISTS idx_audit_log_created ON audit_log(created_at);
