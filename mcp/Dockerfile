# Minimal image for the Lumi Trades MCP server (stdio). Used by directories such as Glama to start
# the server and run MCP introspection. Free tools work without XRPL_SEED; paid tools return quotes.
FROM node:20-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
ENTRYPOINT ["node", "src/index.js"]
