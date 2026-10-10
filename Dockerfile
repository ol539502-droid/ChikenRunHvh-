# ChikenRunHvh: one container runs the game server, which also serves the built game page.
# Railway (and any Docker host) builds this automatically. Keep the database on a volume at /data.

# ---- Build: install everything, bundle the client and the server ----
FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY client/package.json client/
COPY server/package.json server/
COPY shared/package.json shared/
RUN npm ci
COPY . .
RUN npm run build

# ---- Run: only what the server needs at runtime ----
FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
COPY client/package.json client/
COPY server/package.json server/
COPY shared/package.json shared/
RUN npm ci --omit=dev --workspace server && npm cache clean --force
COPY --from=build /app/server/dist server/dist
COPY --from=build /app/client/dist client/dist

# The SQLite database (accounts, coins, items). Mount a persistent volume here, or every deploy
# starts with an empty database.
ENV DB_PATH=/data/game.db
# Railway puts exactly one proxy in front of the app: trust it for real client IPs and HTTPS.
ENV TRUST_PROXY=1
EXPOSE 3000
CMD ["node", "server/dist/index.js"]
