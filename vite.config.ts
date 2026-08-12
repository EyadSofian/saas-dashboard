// @lovable.dev/vite-tanstack-config already includes the following — do NOT add them manually
// or the app will break with duplicate plugins:
//   - TanStack devtools (dev-only, first), tanstackStart, viteReact, tailwindcss, tsConfigPaths,
//     nitro (build-only using cloudflare as a default target), VITE_* env injection, @ path alias,
//     React/TanStack dedupe, error logger plugins, and sandbox detection (port/host/strictPort).
// You can pass additional config via defineConfig({ vite: { ... }, etc... }) if needed.
import { defineConfig } from "@lovable.dev/vite-tanstack-config";

export default defineConfig({
  tanstackStart: {
    // Redirect TanStack Start's bundled server entry to src/server.ts (our SSR error wrapper).
    // nitro/vite builds from this
    server: { entry: "server" },
  },
  nitro: {
    // The wrapper defaults to "cloudflare-module". Railway runs a plain Node
    // process, so build a standalone Node server instead: the output is
    // `.output/server/index.mjs`, started by `npm start` and listening on $PORT.
    preset: "node-server",
  },
  vite: {
    ssr: {
      // Better Auth depends on zod v4 while the app is pinned to zod v3, and npm
      // installs both (v4 nested under better-auth). Bundling better-auth makes
      // the bundler resolve its `zod` imports to the hoisted v3 copy, where
      // `z.email()` does not exist — it would fail at runtime, not build time.
      // Keeping it external lets Node resolve the nested v4 copy correctly.
      //
      // Remove this once the app itself moves to zod v4; that migration touches
      // existing metric and route validation and is deliberately out of scope
      // for the Workspace Onboarding Skeleton milestone.
      external: ["better-auth", "pg", "embedded-postgres"],
    },
  },
});
