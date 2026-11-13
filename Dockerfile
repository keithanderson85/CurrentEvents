# syntax=docker/dockerfile:1
FROM node:22-alpine

ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/app/data

WORKDIR /app

# Install dependencies first so they're cached between code changes.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY server.js ./
COPY src ./src
COPY public ./public

# Saved events, notes and chats live here; mount a volume to keep them.
RUN mkdir -p /app/data && chown -R node:node /app/data
USER node
VOLUME ["/app/data"]

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/auth/me').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# The OpenRouter key is passed in at run time (env var or --env-file), never baked into the image.
CMD ["node", "server.js"]
