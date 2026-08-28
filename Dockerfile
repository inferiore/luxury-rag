# syntax=docker/dockerfile:1

# ---- Stage 1: builder -------------------------------------------------
# Installs full deps (incl. devDependencies) and compiles TypeScript -> dist/.
FROM node:20-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json tsconfig.build.json nest-cli.json ./
COPY src ./src

RUN npm run build

# ---- Stage 2: runner ----------------------------------------------------
# Production image: only prod deps + compiled dist/, runs migrations then
# starts the compiled app.
FROM node:20-alpine AS runner

ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY --from=builder /app/dist ./dist

EXPOSE 3000

# Runs pending TypeORM migrations (schema lives only in migrations, see
# src/database/typeorm.config.ts: synchronize is always false) against the
# compiled data source before starting the server. Safe to run on every
# boot: typeorm migration:run is a no-op when there is nothing pending.
CMD ["sh", "-c", "node_modules/.bin/typeorm migration:run -d dist/database/data-source.js && node dist/main.js"]
