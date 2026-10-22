import { defineConfig, configDefaults } from "vitest/config";

// mcp/ is a separate npm package with its own node:test suite (npm run test:mcp).
export default defineConfig({ test: { exclude: [...configDefaults.exclude, "mcp/**"] } });
