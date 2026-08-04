# syntax=docker/dockerfile:1
#
# The Node minor is pinned rather than floating on `node:24-alpine`, so a rebuild months
# from now produces the same runtime. Bump it deliberately, as a visible change.

# ── build ────────────────────────────────────────────────────────────────────
FROM node:24.18-alpine AS build

WORKDIR /app

# Dependencies first, so a source-only change does not reinstall them.
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ── runtime ──────────────────────────────────────────────────────────────────
FROM node:24.18-alpine AS runtime

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/dist ./dist

# The official Node images ship an unprivileged `node` user; running as root is never needed.
USER node

EXPOSE 3000

# tsconfig has rootDir ".", so compiled sources keep their src/ prefix inside dist/.
CMD ["node", "dist/src/server.js"]
