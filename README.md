# Enginne — Mercado Livre ↔ Claude (MCP)

Conector MCP (Model Context Protocol) que permite ao Claude consultar, em
linguagem natural, os dados de contas do Mercado Livre que você administra:
anúncios, estoque, preços, vendas, pedidos, visitas, perguntas, envios,
reputação e promoções. **V1 é somente leitura** — nenhuma tool altera dados
no Mercado Livre.

Arquitetura multi-tenant desde o início: uma aplicação Mercado Livre, N
sellers (clientes) conectados, cada um com sua própria autorização OAuth e
tokens isolados. Ver [`docs/ARQUITETURA.md`](docs/ARQUITETURA.md) para o
desenho completo.

## Sumário

- [Pré-requisitos](#pré-requisitos)
- [Instalação local](#instalação-local)
- [Configuração (variáveis de ambiente)](#configuração-variáveis-de-ambiente)
- [Criar a aplicação no Mercado Livre](#criar-a-aplicação-no-mercado-livre)
- [OAuth — como funciona](#oauth--como-funciona)
- [Adicionar um seller](#adicionar-um-seller)
- [Remover um seller](#remover-um-seller)
- [Renovar autorização de um seller](#renovar-autorização-de-um-seller)
- [Testando localmente](#testando-localmente)
- [Deploy (hospedagem remota)](#deploy-hospedagem-remota)
- [Conectar ao Claude](#conectar-ao-claude)
- [Ferramentas MCP disponíveis](#ferramentas-mcp-disponíveis)
- [Escalando para Postgres](#escalando-para-postgres)
- [Troubleshooting](#troubleshooting)
- [Segurança](#segurança)

## Pré-requisitos

- Node.js 20+ (recomendado 22).
- Uma conta de desenvolvedor no Mercado Livre (pode ser a mesma conta
  vendedora, mas recomenda-se pessoa jurídica — ver seção de criação do app).
- Um lugar para hospedar o servidor com HTTPS público e estável (ver
  [Deploy](#deploy-hospedagem-remota)) — necessário porque o OAuth do
  Mercado Livre exige um `redirect_uri` HTTPS fixo.

## Instalação local

```bash
git clone <este repositório>
cd ml-enginne
npm install
cp .env.example .env
# edite o .env (ver próxima seção)
npm run db:migrate
npm run build
```

## Configuração (variáveis de ambiente)

Todas as variáveis estão documentadas em [`.env.example`](.env.example).
Resumo:

| Variável | Obrigatória | Descrição |
|---|---|---|
| `PORT` | não (default 8787) | Porta HTTP local |
| `PUBLIC_BASE_URL` | **sim** | URL pública e estável deste servidor (HTTPS em produção) |
| `ML_CLIENT_ID` / `ML_CLIENT_SECRET` | **sim** | Credenciais da aplicação criada no DevCenter do Mercado Livre |
| `ML_AUTH_DOMAIN` | não (default `.com.br`) | Domínio de autorização por país |
| `TOKEN_ENCRYPTION_KEY` | **sim** | Chave AES-256 (base64) para cifrar tokens em repouso. Gere com `openssl rand -base64 32` |
| `MCP_API_KEY` | **sim** | Protege o endpoint `/mcp` — o conector do Claude envia isso como Bearer token |
| `DATABASE_PATH` | não | Caminho do arquivo SQLite |

Nunca commite o `.env` (já está no `.gitignore`). Em produção, configure essas
variáveis no painel de "Secrets"/"Environment Variables" da plataforma de
hospedagem — nunca no código.

## Criar a aplicação no Mercado Livre

Isto **precisa ser feito por um humano** — envolve login na sua conta ML.
Passo a passo (conferido na documentação oficial em
`developers.mercadolivre.com.br`, atualizada em 29-30/12/2025):

1. Acesse **https://developers.mercadolivre.com.br/devcenter** e faça login
   com a conta que será a **proprietária definitiva** da integração
   (recomendado: conta de pessoa jurídica, para evitar problemas de
   transferência depois).
2. Clique em **"Criar uma aplicação"**.
3. Preencha:
   - **Nome**: `Enginne` (ou o nome que preferir — precisa ser único na plataforma).
   - **Nome curto**: `enginne` (usado na URL da aplicação).
   - **Descrição**: até 150 caracteres, ex.: *"Integração de leitura para
     análise de vendas, estoque e anúncios via Claude (MCP)."*
   - **Logo**: opcional.
   - **URLs de redirecionamento**: a raiz do domínio + `/oauth/callback`.
     - Se você **ainda não fez o deploy**, use um placeholder válido em
       HTTPS por enquanto (ex. `https://example.com/oauth/callback`) e edite
       depois em "Configurações" — o Mercado Livre permite editar isso a
       qualquer momento.
     - Se **já fez o deploy** (Railway, etc.), use a URL real:
       `https://SEU-DOMINIO/oauth/callback` (precisa ser HTTPS e bater
       exatamente com o `PUBLIC_BASE_URL` configurado no servidor).
   - **Use PKCE**: marque como habilitado (recomendado; o Enginne já envia
     `code_challenge`/`code_verifier` em todo o fluxo).
   - **Escopos**: marque **Leitura** (não marque Escrita — a V1 é somente leitura).
   - **Tópicos/Notificações**: pode deixar em branco por enquanto (o V1 não
     usa webhooks; é só leitura sob demanda).
4. Salve. Você verá o **Client ID** (`APP ID`) e a **Secret Key**.

**O que NÃO compartilhar comigo (Claude):** o Client Secret. Cole-o
diretamente no seu `.env` local ou no painel de variáveis de ambiente da
hospedagem — nunca aqui no chat.

**Quando voltar:** me diga só "criei o app" — eu continuo sozinho a partir
daí, configurando o restante do projeto para usar essas credenciais (que
você já vai ter colocado no `.env`/secrets, não no chat).

## OAuth — como funciona

Fluxo Authorization Code (server-side) com PKCE, exatamente como documentado
oficialmente:

1. Um humano (dono da conta ML do seller) abre:
   `GET {PUBLIC_BASE_URL}/oauth/start?seller=nome_interno`
2. O Enginne redireciona para `https://{ML_AUTH_DOMAIN}/authorization` com
   `client_id`, `redirect_uri`, `state` (anti-CSRF) e `code_challenge` (PKCE).
3. O usuário loga no Mercado Livre e autoriza o app (isso é 100% do lado da ML — 
   o Enginne nunca vê a senha do seller).
4. A ML redireciona de volta para `{PUBLIC_BASE_URL}/oauth/callback?code=...&state=...`.
5. O Enginne troca o `code` por `access_token` + `refresh_token` (`POST
   /oauth/token`), cifra e salva no banco, e mostra uma página de sucesso.
6. Dali em diante, toda tool que usa `seller="nome_interno"` renova o
   `access_token` automaticamente quando ele está perto de expirar (o access
   token dura 6 horas; o refresh token é de uso único e é substituído a cada
   renovação, como exige a documentação da ML).

## Adicionar um seller

```bash
npm run oauth:add-seller -- moncloa
```

Isso imprime um link. **Envie esse link para o dono da conta do Mercado
Livre "Moncloa"** abrir no navegador dele e autorizar — é uma etapa humana
obrigatória (login + tela de consentimento do Mercado Livre). Depois disso,
confirme com:

```bash
npm run oauth:list-sellers
```

O status deve aparecer como `active`.

## Remover um seller

```bash
npm run oauth:remove-seller -- moncloa
```

Isso apaga os tokens locais. **Não revoga automaticamente do lado da ML** —
o dono da conta pode revogar em "Meus aplicativos" (como titular do app) ou
diretamente nas configurações da própria conta dele.

## Renovar autorização de um seller

Normalmente automático (o `access_token` renova sozinho). Se um seller
aparecer com status `error` ou `expired` (ex.: o `refresh_token` de 6 meses
expirou, ou o seller trocou a senha), refaça a autorização do zero:

```bash
npm run oauth:add-seller -- moncloa
```

## Testando localmente

```bash
npm run dev          # sobe o servidor HTTP em http://localhost:8787
curl http://localhost:8787/health
```

Para testar o OAuth localmente, o Mercado Livre precisa conseguir alcançar
seu `redirect_uri` — em `localhost` isso não funciona. Use um túnel HTTPS
(ex. `ngrok http 8787`) e configure `PUBLIC_BASE_URL` com a URL do túnel
(lembre de também atualizar o Redirect URI no app do DevCenter enquanto
estiver testando dessa forma).

Também é possível rodar via stdio para um cliente MCP local:

```bash
npm run dev:stdio
```

## Deploy (hospedagem remota)

**Escolha: Railway.** Comparado com Render, Cloudflare Workers e Vercel:

| Critério | Railway | Render | Cloudflare Workers | Vercel |
|---|---|---|---|---|
| Node.js "tradicional" (Express, processo longo) | ✅ nativo | ✅ nativo | ⚠️ precisa reescrever para Workers/Durable Objects | ⚠️ funções serverless, não processo longo |
| SQLite com `better-sqlite3` (módulo nativo) | ✅ com volume persistente | ✅ com disco persistente (pago) | ❌ sem filesystem persistente | ❌ sem filesystem persistente |
| Sessões MCP em memória (Streamable HTTP) | ✅ processo sempre ativo | ✅ processo sempre ativo (plano pago) | ❌ modelo stateless por request | ❌ timeout curto por função |
| Custo mínimo sempre-ativo | ~$5/mês (crédito incluso no Hobby) | $7/mês + disco ($0,25/GB/mês) | grátis (mas exige reescrita) | plano função paga |
| Deploy automático por push | ✅ | ✅ | ✅ | ✅ |
| HTTPS incluso | ✅ | ✅ | ✅ | ✅ |

Cloudflare e Vercel são otimizados para funções serverless/edge — nosso
servidor mantém sessões MCP e um arquivo SQLite em memória/disco entre
requisições, o que pede um processo Node.js "tradicional" de longa duração.
Isso descarta os dois sem uma reescrita significativa (Durable Objects + D1
no caso do Cloudflare). Entre Railway e Render, ambos atendem bem; Railway
foi escolhido por ser ligeiramente mais barato no ponto de entrada e ter
volumes persistentes inclusos em todos os planos (inclusive o Hobby).

### Passo a passo (dashboard, sem CLI, sem compartilhar nada sensível comigo)

Esta etapa também **precisa ser feita por você** (criação de conta):

1. Crie uma conta em **https://railway.com** (pode ser com GitHub).
2. Suba este projeto para um repositório no **seu** GitHub (eu preparo o
   `git init`/commit local; o push para um repositório remoto seu é a parte
   que só você pode autorizar/fazer, pois exige login no GitHub).
3. No Railway: **New Project → Deploy from GitHub repo** → selecione o
   repositório.
4. O Railway vai detectar o `Dockerfile` automaticamente (já incluído neste
   projeto). Não é necessário nenhum comando manual.
5. Em **Variables**, adicione todas as variáveis do `.env.example` com os
   valores reais (incluindo `ML_CLIENT_ID`/`ML_CLIENT_SECRET` da etapa
   anterior). **Cole os valores direto no formulário do Railway — não aqui
   no chat.**
6. Em **Settings → Networking**, gere um domínio público (`*.up.railway.app`)
   ou conecte um domínio próprio. Copie essa URL para `PUBLIC_BASE_URL` (e
   redeploy).
7. Em **Settings → Volumes**, crie um volume e monte em `/data`; ajuste
   `DATABASE_PATH=/data/enginne.sqlite`.
8. Volte ao DevCenter do Mercado Livre e atualize o **Redirect URI** do app
   para `https://SEU-DOMINIO-RAILWAY/oauth/callback` (precisa bater
   exatamente com `PUBLIC_BASE_URL`).

**Quando voltar:** me diga a URL pública gerada (essa não é sensível) e
confirme que salvou as variáveis — eu valido a saúde do servidor
(`/health` e `diagnosticar_integracao`) e sigo para os próximos checkpoints.

## Conectar ao Claude

Depois do deploy:

1. No Claude, vá em **Configurações → Conectores → Adicionar conector MCP
   customizado** (o nome exato do menu pode variar conforme a versão do
   produto — procure por "MCP" ou "Conectores").
2. **Nome**: `Mercado Livre - Enginne`.
3. **URL do servidor**: `https://SEU-DOMINIO-RAILWAY/mcp`.
4. **Autenticação**: Bearer token — cole o valor de `MCP_API_KEY` (o mesmo
   que você configurou nas variáveis de ambiente do servidor).
5. Salve e teste com: *"Liste minhas contas conectadas do Mercado Livre."*
   e depois *"Analise as vendas dos últimos 30 dias de uma das contas."*

## Ferramentas MCP disponíveis

Todas somente leitura. `seller` é sempre o **nome interno** (não o nickname
do Mercado Livre) — descubra os nomes com `listar_contas`.

| Tool | Descrição |
|---|---|
| `listar_contas` | Lista sellers configurados e status da autorização |
| `consultar_seller` | Dados da conta (nickname, reputação, país) |
| `listar_anuncios` | Lista anúncios (paginado, filtra por status) |
| `consultar_anuncio` | Detalhe de um anúncio (preço, estoque, descrição) |
| `consultar_status_anuncio` | Status atual de um anúncio |
| `consultar_estoque` | Estoque disponível de um anúncio |
| `consultar_preco` | Preço atual de um anúncio |
| `consultar_vendas` | Resumo de vendas em N dias |
| `consultar_pedidos` | Lista pedidos em N dias, com itens |
| `consultar_visitas` | Visitas de anúncios em N dias |
| `consultar_perguntas` | Perguntas recebidas (padrão: não respondidas) |
| `consultar_envios` | Status de um envio específico |
| `consultar_reputacao` | Nível de reputação, power seller, métricas |
| `consultar_promocoes` | Campanhas/promoções ativas |
| `buscar_produtos_sem_vendas` | Produtos com estoque e zero vendas no período |
| `comparar_periodos` | Compara período atual vs. anterior (faturamento, conversão, produtos que subiram/caíram) |
| `analisar_queda_vendas` | SKUs com maior queda de vendas, ordenados |
| `diagnosticar_integracao` | Checagem de saúde: API ML, OAuth, banco, MCP, seller, token |

## Escalando para Postgres

SQLite atende bem uma única instância. Se no futuro for necessário rodar
múltiplas réplicas do servidor (alta disponibilidade), migre `sellers`,
`oauth_pending` e `audit_log` (schema em `src/database/schema.sql`) para
Postgres gerenciado (o próprio Railway oferece um addon). A lógica de
`sellersRepo.ts` foi escrita com queries simples e portáveis — a migração é
principalmente trocar o driver (`better-sqlite3` → `pg`), sem mudar o
formato dos dados (os tokens continuam cifrados do mesmo jeito antes de
chegar ao banco).

## Troubleshooting

- **`Sorry, the application cannot connect to your account`** durante o
  OAuth: geralmente é `redirect_uri` não batendo exatamente com o
  configurado no app, ou o vendedor tentando logar como
  operador/colaborador em vez da conta principal (dá erro
  `invalid_operator_user_id`).
- **Seller com status `error`**: rode `npm run oauth:renew-seller --
  nome_do_cliente` para ver a mensagem de erro específica. Se o
  `refresh_token` expirou (6 meses sem uso) ou foi revogado, é necessário
  `npm run oauth:add-seller -- nome_do_cliente` de novo.
- **429 (rate limit) da API do Mercado Livre**: o cliente HTTP já faz retry
  com backoff automaticamente. Se persistir, ainda tente reduzir a
  frequência de chamadas ou verificar `Boas práticas para usar a
  plataforma` na documentação oficial.
- Rode `diagnosticar_integracao` (tool MCP) ou `npm run diagnose --
  nome_do_cliente` a qualquer momento para uma checagem completa.

## Segurança

Ver a seção "Segurança em profundidade" em
[`docs/ARQUITETURA.md`](docs/ARQUITETURA.md). Resumo das regras que o código
segue:

- Nenhum token em texto plano no banco (AES-256-GCM).
- Nenhum segredo no código-fonte ou no Git (`.env` no `.gitignore`,
  `.env.example` sem valores reais).
- Nenhum token nos logs (`pino` com `redact`).
- Endpoint MCP protegido por Bearer token.
- Isolamento estrito entre sellers — toda tool valida o seller contra o
  banco antes de qualquer chamada à API.
- V1 é somente leitura — nenhuma tool executa PUT/POST/DELETE na API do
  Mercado Livre.
