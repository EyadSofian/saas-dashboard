// @lovable.dev/vite-tanstack-config bundles TanStack devtools, tanstackStart,
// viteReact, tailwindcss, tsConfigPaths, nitro, the @ alias and React dedupe.
// Do not re-add those plugins here.
import { defineConfig } from "@lovable.dev/vite-tanstack-config";

export default defineConfig({
  tanstackStart: { server: { entry: "server" } },
  nitro: { preset: "node-server" },
  vite: {
    ssr: {
      // better-auth depends on zod v4 while the app is on v3 (npm installs both,
      // v4 nested). Bundling it would resolve its zod imports to the hoisted v3
      // copy, where z.email() does not exist — a runtime failure, not a build
      // one. Keeping it external lets Node resolve the nested copy.
      external: ["better-auth", "pg", "embedded-postgres"],
    },
  },
});
