# BladeOS — one image for any container host: Fly.io, Render, Koyeb, DigitalOcean App Platform,
# Google Cloud Run, Northflank, or a VPS with Docker. Needs a PostgreSQL 14+ database (DATABASE_URL).
# Build: docker build -t bladeos .     Run: docker run -p 8080:8080 --env-file .env bladeos

FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim
ENV NODE_ENV=production \
    PORT=8080
WORKDIR /app
COPY --from=build --chown=node:node /app/package.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/server ./server
COPY --from=build --chown=node:node /app/migrations ./migrations
COPY --from=build --chown=node:node /app/src/shared ./src/shared
USER node
EXPOSE 8080
# Database migrations run on start-up; /health answers once the database is reachable.
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server/index.js"]
