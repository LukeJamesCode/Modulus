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
# First-party modules ship as TypeScript source and run via tsx (a production
# dependency the CLI registers at startup) — they are NOT compiled into dist/.
# Copying them to /app/modules is where defaultModuleRoots() resolves the
# first-party root in the image layout (dist/cli/index.js → ../../modules), so
# the daemon discovers and lists all of them. Heavy modules (browser, discord)
# additionally need their own npm packages, which install into a writable
# modules folder at enable time; the default read-only container can't do that,
# so point those at a user-modules volume (see README "Running in Docker").
COPY modules ./modules
RUN mkdir -p /data && chown node:node /data && chmod 700 /data
VOLUME ["/data"]
USER node
CMD ["node", "dist/cli/index.js", "start"]
