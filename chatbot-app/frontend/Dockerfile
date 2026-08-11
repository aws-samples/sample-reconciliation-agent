# Multi-stage build for optimized production image
# Use AWS Public ECR to avoid Docker Hub rate limits
FROM public.ecr.aws/docker/library/node:24-alpine AS deps
RUN apk add --no-cache libc6-compat
WORKDIR /app
COPY package.json package-lock.json* ./
# Configure npm with increased timeout and retry logic for better reliability
RUN npm config set fetch-retry-mintimeout 20000 && \
    npm config set fetch-retry-maxtimeout 120000 && \
    npm config set fetch-retries 5 && \
    npm ci

FROM public.ecr.aws/docker/library/node:24-alpine AS builder
WORKDIR /app

# Build arguments for Next.js environment variables.
# NEXT_PUBLIC_* are read by the browser bundle, so they MUST be set before
# `npm run build` (Next.js inlines them at build time, not runtime).
# Entra inbound auth: tenant + client + audience are required by msal-config.ts;
# missing any one disables HAS_ENTRA_CONFIG and the AuthWrapper bypasses login.
ARG NEXT_PUBLIC_AWS_REGION
ARG NEXT_PUBLIC_ENTRA_TENANT_ID
ARG NEXT_PUBLIC_ENTRA_CLIENT_ID
ARG NEXT_PUBLIC_ENTRA_API_AUDIENCE
ARG NEXT_PUBLIC_STREAMING_API_URL
ARG NEXT_PUBLIC_GOOGLE_MAPS_EMBED_API_KEY
ARG NEXT_PUBLIC_DEFAULT_KEYS
ARG CORS_ORIGINS
# Recon platform: Cognito OAuth (code+PKCE) + BFF base for reconApi/auth (src/lib).
ARG NEXT_PUBLIC_RECON_API_BASE
ARG NEXT_PUBLIC_COGNITO_HOSTED_UI
ARG NEXT_PUBLIC_COGNITO_CLIENT_ID
ARG NEXT_PUBLIC_COGNITO_REDIRECT_URI
ARG NEXT_PUBLIC_AUTH_PROVIDER
ARG NEXT_PUBLIC_OKTA_ISSUER
ARG NEXT_PUBLIC_OKTA_CLIENT_ID
# Pins the OIDC callback URL instead of deriving it from the browser's origin, which drifts every
# time the CloudFront domain changes (live-QA P0-1). Empty = derive it (fine for local dev).
ARG NEXT_PUBLIC_OKTA_REDIRECT_URI

# Set environment variables for build
ENV NEXT_PUBLIC_AWS_REGION=$NEXT_PUBLIC_AWS_REGION
ENV NEXT_PUBLIC_ENTRA_TENANT_ID=$NEXT_PUBLIC_ENTRA_TENANT_ID
ENV NEXT_PUBLIC_ENTRA_CLIENT_ID=$NEXT_PUBLIC_ENTRA_CLIENT_ID
ENV NEXT_PUBLIC_ENTRA_API_AUDIENCE=$NEXT_PUBLIC_ENTRA_API_AUDIENCE
ENV NEXT_PUBLIC_STREAMING_API_URL=$NEXT_PUBLIC_STREAMING_API_URL
ENV NEXT_PUBLIC_GOOGLE_MAPS_EMBED_API_KEY=$NEXT_PUBLIC_GOOGLE_MAPS_EMBED_API_KEY
ENV NEXT_PUBLIC_DEFAULT_KEYS=$NEXT_PUBLIC_DEFAULT_KEYS
ENV CORS_ORIGINS=$CORS_ORIGINS
ENV NEXT_PUBLIC_RECON_API_BASE=$NEXT_PUBLIC_RECON_API_BASE
ENV NEXT_PUBLIC_COGNITO_HOSTED_UI=$NEXT_PUBLIC_COGNITO_HOSTED_UI
ENV NEXT_PUBLIC_COGNITO_CLIENT_ID=$NEXT_PUBLIC_COGNITO_CLIENT_ID
ENV NEXT_PUBLIC_COGNITO_REDIRECT_URI=$NEXT_PUBLIC_COGNITO_REDIRECT_URI
ENV NEXT_PUBLIC_AUTH_PROVIDER=$NEXT_PUBLIC_AUTH_PROVIDER
ENV NEXT_PUBLIC_OKTA_ISSUER=$NEXT_PUBLIC_OKTA_ISSUER
ENV NEXT_PUBLIC_OKTA_CLIENT_ID=$NEXT_PUBLIC_OKTA_CLIENT_ID
ENV NEXT_PUBLIC_OKTA_REDIRECT_URI=$NEXT_PUBLIC_OKTA_REDIRECT_URI

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Debug: Print environment variables (Entra IDs are not secrets — they're
# already exposed in every browser bundle).
RUN echo "Build-time env vars:" \
 && echo "NEXT_PUBLIC_AWS_REGION=$NEXT_PUBLIC_AWS_REGION" \
 && echo "NEXT_PUBLIC_ENTRA_TENANT_ID=$NEXT_PUBLIC_ENTRA_TENANT_ID" \
 && echo "NEXT_PUBLIC_ENTRA_CLIENT_ID=$NEXT_PUBLIC_ENTRA_CLIENT_ID" \
 && echo "NEXT_PUBLIC_ENTRA_API_AUDIENCE=$NEXT_PUBLIC_ENTRA_API_AUDIENCE" \
 && echo "NEXT_PUBLIC_STREAMING_API_URL=$NEXT_PUBLIC_STREAMING_API_URL" \
 && echo "NEXT_PUBLIC_GOOGLE_MAPS_EMBED_API_KEY=${NEXT_PUBLIC_GOOGLE_MAPS_EMBED_API_KEY:0:10}..." \
 && echo "NEXT_PUBLIC_DEFAULT_KEYS=$NEXT_PUBLIC_DEFAULT_KEYS" \
 && echo "CORS_ORIGINS=$CORS_ORIGINS"

RUN npm run build

# Production stage with Node.js (standalone mode)
FROM public.ecr.aws/docker/library/node:24-alpine AS runner
WORKDIR /app

# Don't run production as root
RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 nextjs

# Copy the standalone output
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public

# Set the correct permission for prerender cache
RUN mkdir -p .next
RUN chown nextjs:nodejs .next

USER nextjs

EXPOSE 3000

ENV PORT=3000
ENV HOSTNAME="0.0.0.0"

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD wget --no-verbose --tries=1 --spider http://localhost:3000/health || exit 1

CMD ["node", "server.js"]
