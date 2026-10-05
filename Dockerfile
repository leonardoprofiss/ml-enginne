# syntax=docker/dockerfile:1
FROM node:22-slim AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

# Só as dependências de produção na imagem final.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY --from=build /app/dist ./dist

# Os dados (contas conectadas e tokens cifrados) ficam no Firestore, então o
# contêiner não precisa de disco persistente. O Cloud Run informa a porta pela
# variável PORT, que o servidor já lê sozinho.
USER node
CMD ["node", "dist/server/index.js"]
