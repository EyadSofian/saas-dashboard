import { createFileRoute } from "@tanstack/react-router";

// Better Auth owns every /api/auth/* path (sign-in, sign-up, sign-out, session).
// Handing it the raw Request keeps its cookie and CSRF handling intact rather
// than reimplementing them.
export const Route = createFileRoute("/api/auth/$")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const { getAuth } = await import("@/platform/auth");
        return getAuth().handler(request);
      },
      POST: async ({ request }) => {
        const { getAuth } = await import("@/platform/auth");
        return getAuth().handler(request);
      },
    },
  },
});
