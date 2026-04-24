# Stage 1: Build
FROM node:22-bookworm AS builder
RUN corepack enable && corepack prepare pnpm@10 --activate
WORKDIR /app
# Copy workspace root files first (layer caching)
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
# Copy all package.json files for dependency install
COPY packages/*/package.json ./packages/*/
# Install all dependencies (including dev for build)
RUN pnpm install --frozen-lockfile
# Copy source
COPY packages/ ./packages/
# Build all packages
RUN pnpm -r build
# Remove dev dependencies for production image
RUN pnpm prune --prod

# Stage 2: Runtime
FROM node:22-bookworm-slim
WORKDIR /app
# Copy production node_modules, packages, and root config
COPY --from=builder /app/node_modules/ ./node_modules/
COPY --from=builder /app/packages/ ./packages/
COPY --from=builder /app/package.json /app/pnpm-lock.yaml /app/pnpm-workspace.yaml ./
# Embedded default config for Docker (all secrets via env:)
COPY packages/runtime/docker/raiflow.yml /app/raiflow.yml
# Data volume for SQLite and API key
VOLUME /data
ENV NODE_ENV=production
ENV RAIFLOW_CONFIG_PATH=/app/raiflow.yml
EXPOSE 3100
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://localhost:3100/health').then(r=>r.ok?process.exit(0):process.exit(1)).catch(()=>process.exit(1))"
CMD ["node", "packages/runtime/dist/main.js"]
