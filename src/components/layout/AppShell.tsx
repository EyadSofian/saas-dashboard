// Application shell: navigation, workspace switcher, language and theme.
//
// The sidebar collapses to a bottom bar on mobile rather than hiding behind a
// hamburger, because the five destinations are the product and an owner opening
// this on a phone should reach any of them in one tap.
import { Link, useRouterState } from "@tanstack/react-router";
import {
  Building2,
  ChevronDown,
  Database,
  Gauge,
  Languages,
  LayoutDashboard,
  LogOut,
  Moon,
  Route as RouteIcon,
  Sun,
  Users,
} from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useI18n, type DictKey } from "@/lib/i18n";
import { useSession } from "@/lib/session";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/primitives";
import { CopilotPanel } from "@/components/copilot/CopilotPanel";

interface NavItem {
  to: string;
  key: DictKey;
  icon: typeof LayoutDashboard;
}

const NAV: NavItem[] = [
  { to: "/", key: "nav_overview", icon: LayoutDashboard },
  { to: "/onboarding", key: "nav_onboarding", icon: Database },
  { to: "/mapping", key: "nav_mapping", icon: RouteIcon },
  { to: "/dashboards", key: "nav_dashboards", icon: Gauge },
  { to: "/data-health", key: "nav_data_health", icon: Users },
];

function isActive(pathname: string, to: string): boolean {
  return to === "/" ? pathname === "/" : pathname === to || pathname.startsWith(`${to}/`);
}

export function AppShell({ children }: { children: ReactNode }) {
  const { t, lang, toggleLang, theme, toggleTheme } = useI18n();
  const pathname = useRouterState({ select: (s) => s.location.pathname });

  return (
    <div className="flex min-h-dvh flex-col bg-bg text-text">
      <TopBar />
      <div className="flex flex-1">
        {/* Desktop sidebar. `border-e` is logical, so it mirrors in RTL. */}
        <nav className="hidden w-56 shrink-0 border-e border-border bg-surface p-3 md:block">
          <ul className="space-y-1">
            {NAV.map((item) => {
              const active = isActive(pathname, item.to);
              return (
                <li key={item.to}>
                  <Link
                    to={item.to}
                    aria-current={active ? "page" : undefined}
                    className={cn(
                      "flex items-center gap-2.5 rounded-md px-3 py-2 text-sm transition-colors",
                      active
                        ? "bg-brand-soft font-medium text-brand-ink"
                        : "text-text-muted hover:bg-surface-2 hover:text-text",
                    )}
                  >
                    <item.icon className="size-4 shrink-0" />
                    {t(item.key)}
                  </Link>
                </li>
              );
            })}
          </ul>

          <div className="mt-6 space-y-1 border-t border-border pt-3">
            <button
              type="button"
              onClick={toggleLang}
              className="flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-sm text-text-muted hover:bg-surface-2"
            >
              <Languages className="size-4" />
              {lang === "ar" ? "English" : "العربية"}
            </button>
            <button
              type="button"
              onClick={toggleTheme}
              className="flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-sm text-text-muted hover:bg-surface-2"
            >
              {theme === "dark" ? <Sun className="size-4" /> : <Moon className="size-4" />}
              {theme === "dark" ? "Light" : "Dark"}
            </button>
          </div>
        </nav>

        <main className="min-w-0 flex-1 p-4 pb-24 md:p-6 md:pb-6">{children}</main>
      </div>

      <CopilotPanel />

      {/* Mobile bar: all five destinations, no hidden "More" drawer. */}
      <nav className="fixed inset-x-0 bottom-0 z-20 border-t border-border bg-surface md:hidden">
        <ul className="grid grid-cols-5">
          {NAV.map((item) => {
            const active = isActive(pathname, item.to);
            return (
              <li key={item.to}>
                <Link
                  to={item.to}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "flex flex-col items-center gap-1 px-1 py-2 text-[11px]",
                    active ? "text-brand-ink" : "text-text-muted",
                  )}
                >
                  <item.icon className="size-5" />
                  <span className="truncate">{t(item.key)}</span>
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>
    </div>
  );
}

function TopBar() {
  const { t, lang, toggleLang, theme, toggleTheme } = useI18n();
  const { user, workspace, workspaces, selectWorkspace, signOut } = useSession();
  const [open, setOpen] = useState(false);
  const switcherRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function closeOnPointer(event: PointerEvent) {
      if (!switcherRef.current?.contains(event.target as Node)) setOpen(false);
    }
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("pointerdown", closeOnPointer);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnPointer);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  return (
    <header className="sticky top-0 z-30 flex h-14 items-center gap-3 border-b border-border bg-surface px-4">
      <Link to="/" className="flex items-center gap-2 font-semibold">
        <span className="grid size-7 place-items-center rounded-md bg-brand text-text-inverse">
          <Gauge className="size-4" />
        </span>
        <span className="hidden sm:inline">{t("app_name")}</span>
      </Link>

      {workspace && (
        <div ref={switcherRef} className="relative ms-2">
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-haspopup="listbox"
            aria-expanded={open}
            className="flex items-center gap-2 rounded-md border border-border px-2.5 py-1.5 text-sm hover:bg-surface-2"
          >
            <Building2 className="size-3.5 text-text-muted" />
            <span className="max-w-[9rem] truncate">{workspace.name}</span>
            <ChevronDown className="size-3.5 text-text-muted" />
          </button>

          {open && workspaces.length > 0 && (
            <ul
              role="listbox"
              className="absolute top-full z-40 mt-1 min-w-[14rem] rounded-md border border-border bg-surface p-1 shadow-lg"
            >
              {workspaces.map((option) => (
                <li key={option.id}>
                  <button
                    type="button"
                    onClick={() => {
                      selectWorkspace(option.id);
                      setOpen(false);
                    }}
                    className={cn(
                      "flex w-full flex-col items-start rounded px-2.5 py-1.5 text-start text-sm hover:bg-surface-2",
                      option.id === workspace.id && "bg-brand-soft text-brand-ink",
                    )}
                  >
                    <span className="truncate">{option.name}</span>
                    <span className="text-xs text-text-muted">{option.roles.join(" · ")}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <div className="ms-auto flex items-center gap-2">
        <Button
          variant="ghost"
          size="sm"
          className="md:hidden"
          onClick={toggleLang}
          aria-label={lang === "ar" ? "Switch to English" : "التبديل للعربية"}
        >
          <Languages className="size-4" />
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="md:hidden"
          onClick={toggleTheme}
          aria-label={theme === "dark" ? "Light theme" : "Dark theme"}
        >
          {theme === "dark" ? <Sun className="size-4" /> : <Moon className="size-4" />}
        </Button>
        {user && (
          <>
            <span className="hidden text-sm text-text-muted sm:inline">{user.email}</span>
            <Button variant="ghost" size="sm" onClick={signOut} aria-label={t("auth_sign_out")}>
              <LogOut className="size-4" />
            </Button>
          </>
        )}
      </div>
    </header>
  );
}
