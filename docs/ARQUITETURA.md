# Arquitetura — Enginne

## Visão geral

```
                     ┌──────────────────────────────────────────┐
                     │                 Claude                    │
                     │  (usuário conversa: "analise a Moncloa")   │
                     └───────────────────┬────────────────────────┘
                                          │ MCP (Streamable HTTP)
                                          │ Authorization: Bearer MCP_API_KEY
                                          ▼
                     ┌──────────────────────────────────────────┐
                     │        MCP Server "Enginne" (Node.js)      │
                     │  ┌────────────────────────────────────┐  │
                     │  │  Tools (somente leitura)             │  │
                     │  │  listar_contas, consultar_vendas,    │  │
                     │  │  comparar_periodos, ...               │  │
                     │  └───────────────┬────────────────────┘  │
                     │                  │                        │
                     │  ┌───────────────▼────────────────────┐  │
                     │  │  Camada de autenticação (auth/)      │  │
                     │  │  - resolve "seller" -> access_token   │  │
                     │  │  - renova refresh_token automaticamente│ │
                     │  └───────────────┬────────────────────┘  │
                     │                  │                        │
                     │  ┌───────────────▼────────────────────┐  │
                     │  │  Cliente HTTP ML (mercadolivre/)      │  │
                     │  │  - rate limit, retry/backoff, paginação│ │
                     │  └───────────────┬────────────────────┘  │
                     └──────────────────┼────────────────────────┘
                                          │ HTTPS (Bearer <access_token_do_seller>)
                                          ▼
                     ┌──────────────────────────────────────────┐
                     │       API oficial do Mercado Livre         │
                     │           api.mercadolibre.com             │
                     └───────────────────┬────────────────────────┘
                                          │
              ┌───────────────┬───────────┼───────────┬───────────────┐
              ▼               ▼           ▼           ▼               ▼
          Seller A        Seller B    Seller C    Seller D      futuros clientes
         (Moncloa)      (autorização (autorização (autorização   (cada um faz sua
      autorização OAuth   OAuth própria) OAuth própria) OAuth própria)  própria autorização)
        própria)
```

## Por que multi-tenant nativo?

A aplicação Mercado Livre (Client ID + Client Secret) é **uma só** — é o "Enginne"
em si, registrado uma única vez no DevCenter. Cada **seller** (cliente do
Enginne) faz sua **própria** autorização OAuth contra essa mesma aplicação.
O Mercado Livre já modela isso nativamente: uma aplicação pode ter **N
usuários que concederam permissão** (visível em "Administrar Permissões" no
painel da aplicação), cada um com seu próprio par access_token/refresh_token,
seu próprio `user_id`, e sem nenhum vazamento de dados entre eles.

O Enginne mapeia isso em uma tabela `sellers` (ver `src/database/schema.sql`):
cada linha é um `seller_name` (nome interno, ex. "moncloa") + tokens cifrados
+ status da autorização. Toda tool MCP recebe `seller` como parâmetro
obrigatório e todo acesso à API passa pela função `resolveSeller()`, que
garante que o seller existe e está com uma autorização ativa antes de
qualquer chamada — nunca é possível um seller "vazar" para outro, porque o
access_token usado em cada chamada HTTP vem exclusivamente do registro
daquele `seller_name`.

Adicionar um novo cliente = três passos, sem alterar código:
1. `npm run oauth:add-seller -- nome_do_cliente`
2. Enviar o link gerado para o dono da conta ML autorizar (login + consentimento).
3. Pronto — o Claude já pode consultar `seller="nome_do_cliente"`.

## Camadas (pastas)

- **`src/config`** — validação de variáveis de ambiente (fail-fast se faltar algo).
- **`src/auth`** — fluxo OAuth 2.0 (Authorization Code + PKCE) e gerenciamento
  de token (renovação automática, com lock para evitar corrida entre chamadas
  concorrentes, já que o `refresh_token` da ML é de uso único).
- **`src/mercadolivre`** — cliente HTTP fino sobre a API pública, com rate
  limiting local (token bucket), retry com backoff exponencial + jitter para
  429/5xx, e helpers de paginação (offset e scroll) para contas grandes.
- **`src/database`** — SQLite (via better-sqlite3) com os tokens sempre
  cifrados em repouso (AES-256-GCM). Ver "Escalando para Postgres" no README.
- **`src/tools`** — as 18 tools MCP (17 de leitura + `diagnosticar_integracao`),
  cada uma um `ToolDefinition` com schema Zod + handler. Lógica de
  agregação/comparação fica isolada em `analytics.ts` (funções puras,
  testadas sem rede).
- **`src/server`** — dois pontos de entrada:
  - `index.ts`: servidor HTTP remoto (Express + Streamable HTTP transport do
    MCP SDK), protegido por Bearer token, com as rotas `/oauth/start` e
    `/oauth/callback` para o fluxo de autorização de cada seller.
  - `stdio.ts`: entrada alternativa via stdio, para testar localmente com um
    cliente MCP local sem precisar expor HTTP.

## Fluxo de uma pergunta do usuário

1. Usuário: "Compare as vendas dos últimos 30 dias da Moncloa com os 30 dias anteriores."
2. Claude chama a tool `comparar_periodos(seller="moncloa", dias=30)`.
3. O servidor MCP roteia para o handler em `src/tools/analises.ts`.
4. O handler chama `resolveSeller("moncloa")` (banco), depois
   `searchAllOrders()` duas vezes (período atual e anterior) via o cliente
   HTTP (que resolve o access_token válido do seller, aplicando refresh se
   necessário, e pagina/rate-limita as chamadas).
5. `analytics.ts` agrega os pedidos por produto e calcula variações.
6. A tool devolve texto pronto para o Claude narrar + `structuredContent`
   com os números brutos, caso o Claude precise recalcular algo.

## Segurança em profundidade

- Tokens nunca em texto plano: cifrados com AES-256-GCM antes de tocar o disco.
- Endpoint `/mcp` exige `Authorization: Bearer <MCP_API_KEY>` — sem isso, 401.
- `client_secret` só existe em variável de ambiente, nunca no código nem em logs.
- Logger (`pino`) tem `redact` configurado para qualquer campo `token`,
  `access_token`, `refresh_token`, `client_secret`, `authorization`.
- Toda tool que recebe `seller` valida contra o banco antes de tocar a API —
  não existe caminho para um seller acessar dado de outro.
- V1 é 100% somente leitura: nenhuma tool chama PUT/POST/DELETE na API do ML.
