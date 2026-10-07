# Production image for container hosts (Railway, Render, Fly.io, any Docker host).
# Needs DATABASE_URL, APP_URL and SESSION_SECRET at runtime, and a persistent volume for STORAGE_DIR.
FROM node:22-slim
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1

COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY . .
RUN npm run build

ENV NODE_ENV=production
ENV STORAGE_DIR=/data/storage
EXPOSE 3000
CMD ["sh", "scripts/start-hosted.sh"]
