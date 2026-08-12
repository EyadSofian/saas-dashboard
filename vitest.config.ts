import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: {
    alias: { "@": path.resolve(import.meta.dirname, "./src") },
  },
  test: {
    environment: "node",
    globals: false,
    include: ["tests/**/*.test.ts"],
    setupFiles: ["tests/setup.ts"],
    // The suite must never touch production. Anything that tries to open a real
    // socket should fail loudly rather than hang until CI times out.
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
