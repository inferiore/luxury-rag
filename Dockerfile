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

# ---- Stage: frontend-builder --------------------------------------------
# Build de Vite/React como estáticos servidos por el backend en producción.
# Stage independiente de `builder` a propósito: docker-compose.dev.yml usa
# `target: builder` (dev sigue usando el dev server de Vite en :5173, no
# esta copia estática) — con BuildKit, apuntar a `builder` como target NO
# construye este stage en absoluto (no es su dependencia), así que dev no
# paga el costo de este build.
FROM node:20-alpine AS frontend-builder
WORKDIR /app/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend ./
# Vite embebe esto en el bundle JS público en build time (import.meta.env)
# — la key ya está pensada para ser pública (ver VITE_API_KEY en
# frontend/.env.example), así que un ARG plano (visible en las capas de la
# imagen) es un trade-off aceptable, no hace falta BuildKit secrets.
ARG VITE_API_BASE_URL=
ARG VITE_API_KEY=
ENV VITE_API_BASE_URL=$VITE_API_BASE_URL
ENV VITE_API_KEY=$VITE_API_KEY
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
COPY --from=frontend-builder /app/frontend/dist ./public

EXPOSE 3000

# Runs pending TypeORM migrations (schema lives only in migrations, see
# src/database/typeorm.config.ts: synchronize is always false) against the
# compiled data source before starting the server. Safe to run on every
# boot: typeorm migration:run is a no-op when there is nothing pending.
CMD ["sh", "-c", "node_modules/.bin/typeorm migration:run -d dist/database/data-source.js && node dist/main.js"]
