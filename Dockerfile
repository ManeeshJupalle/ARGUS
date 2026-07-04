# Single image for both compose services (server / web) — the command differs.
FROM node:22-slim

WORKDIR /app

# Workspace manifests first so `npm ci` layers cache across code changes.
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci

COPY . .

# server:3001, web (vite dev):5173
EXPOSE 3001 5173