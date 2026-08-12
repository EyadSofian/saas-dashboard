import {
  HeadContent,
  Outlet,
  Scripts,
  createRootRoute,
  useRouterState,
} from "@tanstack/react-router";
import type { ReactNode } from "react";
import { I18nProvider } from "@/lib/i18n";
import { SessionProvider, useSession } from "@/lib/session";
import { AppShell } from "@/components/layout/AppShell";
import styles from "@/styles.css?url";

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "InsightOS" },
      {
        name: "description",
        content: "Odoo analytics with approved mappings, explainable metrics and Arabic-first UI.",
      },
    ],
    links: [{ rel: "stylesheet", href: styles }],
  }),
  component: RootComponent,
});

/** Routes that render without the app shell and without requiring a session. */
const PUBLIC_ROUTES = new Set(["/sign-in", "/sign-up"]);

function RootComponent() {
  return (
    <RootDocument>
      <I18nProvider>
        <SessionProvider>
          <Chrome />
        </SessionProvider>
      </I18nProvider>
    </RootDocument>
  );
}

function Chrome() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const { user, loading } = useSession();

  if (PUBLIC_ROUTES.has(pathname)) return <Outlet />;

  if (loading) {
    return (
      <div className="grid min-h-dvh place-items-center text-text-muted">
        <span className="animate-pulse">…</span>
      </div>
    );
  }

  // Not signed in and not on a public route: render the outlet bare so the
  // page itself can show its own sign-in prompt rather than flashing the shell.
  if (!user) return <Outlet />;

  return (
    <AppShell>
      <Outlet />
    </AppShell>
  );
}

function RootDocument({ children }: { children: ReactNode }) {
  // lang/dir are set here for the first paint and kept in sync by I18nProvider,
  // so an Arabic user never sees an LTR flash before hydration.
  return (
    <html lang="ar" dir="rtl" suppressHydrationWarning>
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  );
}
