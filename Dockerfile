# Modulus runtime image. Ollama is intentionally NOT bundled here -- it lives
# in its own container per docker-compose.yml.

FROM node:20-alpine AS build
WORKDIR /app
COPY package*.json tsconfig.json ./
RUN npm ci
COPY src ./src
COPY scripts ./scripts
RUN npm run build

FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
RUN mkdir -p /data && chown node:node /data && chmod 700 /data
VOLUME ["/data"]
USER node
CMD ["node", "dist/cli/index.js", "start"]
