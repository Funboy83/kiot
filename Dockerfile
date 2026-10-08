FROM node:22-slim AS build
# better-sqlite3 compiles its native addon during npm ci; slim images lack the toolchain.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:22-slim
WORKDIR /app
# Keeps the heap well inside a 512 MB host (Railway Free); the app uses far less.
ENV NODE_ENV=production DB_FILE=/data/store.db PORT=3000 NODE_OPTIONS=--max-old-space-size=192
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY server ./server
EXPOSE 3000
CMD ["node", "server/index.js"]
