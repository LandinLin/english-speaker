# syntax=docker/dockerfile:1

# ── Dependencies ─────────────────────────────────────────────────────
FROM node:22-alpine AS deps
WORKDIR /app
# libc6-compat: some prebuilt optional deps expect glibc-linked binaries.
RUN apk add --no-cache libc6-compat
COPY package.json package-lock.json* ./
RUN npm ci

# ── Build ────────────────────────────────────────────────────────────
FROM node:22-alpine AS builder
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# NEXT_PUBLIC_* are inlined into client bundles at BUILD time. These two
# are public client SDK keys by design (visible to every browser anyway).
ARG NEXT_PUBLIC_DID_CLIENT_KEY
ARG NEXT_PUBLIC_DID_AGENT_ID
ENV NEXT_PUBLIC_DID_CLIENT_KEY=$NEXT_PUBLIC_DID_CLIENT_KEY
ENV NEXT_PUBLIC_DID_AGENT_ID=$NEXT_PUBLIC_DID_AGENT_ID
RUN npm run build

# ── Runtime ──────────────────────────────────────────────────────────
FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
# Non-root user.
RUN addgroup --system --gid 1001 nodejs \
  && adduser --system --uid 1001 nextjs
# Static/public assets (traced server files come from standalone below).
COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
USER nextjs
EXPOSE 3000
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
# /login is a public 200 page once the server is ready.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -q -O - http://127.0.0.1:3000/login | grep -q "English" || exit 1
CMD ["node", "server.js"]
