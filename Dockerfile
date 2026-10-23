# Root Dockerfile for MCP directories (Glama etc.) that build from the repository root.
# It packages the stdio MCP server in ./mcp (published on npm as lumi-trades-mcp); the Cloudflare Worker API in ./src is not part of the image.
# Free tools work with no configuration; set XRPL_SEED (or an EVM key, see mcp/README.md) only to let paid tools pay.
FROM node:20-alpine
WORKDIR /app
COPY mcp/package.json mcp/package-lock.json ./
RUN npm ci --omit=dev
COPY mcp/src ./src
ENTRYPOINT ["node", "src/index.js"]
