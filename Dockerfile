# syntax=docker/dockerfile:1
FROM node:22-slim AS build
WORKDIR /app

# better-sqlite3 compila nativo — precisa de build tools na etapa de build.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

# Reinstala só as dependências de produção (sem devDependencies) na imagem final.
COPY package.json package-lock.json ./
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && npm ci --omit=dev \
    && apt-get purge -y python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

COPY --from=build /app/dist ./dist

# Diretório para o SQLite (configure em DATABASE_PATH, ex: /data/enginne.sqlite).
# Obs: o volume persistente é configurado nativamente no Railway (Settings > Volumes),
# apontando para /data — a diretiva Docker VOLUME não é suportada pelo builder do Railway.
RUN mkdir -p /data

EXPOSE 8787
USER node
CMD ["node", "dist/server/index.js"]
