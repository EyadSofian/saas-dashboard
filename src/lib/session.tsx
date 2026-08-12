// Client-side session and workspace selection.
//
// The workspace id is sent on every /api/v1 request as a header, but it is only
// ever a *request*: the server resolves the real workspace from the user's
// membership and returns 403 if they are not a member. Nothing here is trusted.
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

export interface SessionUser {
  id: string;
  email: string;
  name: string;
}

export interface WorkspaceSummary {
  id: string;
  organizationId: string;
  name: string;
  slug: string;
  timezone: string;
  locale: string;
  baseCurrency: string;
  industryPack: string | null;
  onboardingState: string;
  roles: string[];
}

interface SessionValue {
  user: SessionUser | null;
  workspaces: WorkspaceSummary[];
  workspace: WorkspaceSummary | null;
  loading: boolean;
  selectWorkspace: (id: string) => void;
  refresh: () => Promise<void>;
  signOut: () => Promise<void>;
}

const SessionContext = createContext<SessionValue | null>(null);
const STORAGE_WORKSPACE = "insightos.workspace";

export function SessionProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[]>([]);
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const response = await fetch("/api/v1/session", { headers: { accept: "application/json" } });
      if (!response.ok) {
        setUser(null);
        setWorkspaces([]);
        return;
      }
      const body = await response.json();
      setUser(body.user ?? null);
      setWorkspaces(body.workspaces ?? []);

      // Keep the previously chosen workspace if the user still belongs to it;
      // otherwise fall back to the first one rather than leaving none selected.
      const stored = localStorage.getItem(STORAGE_WORKSPACE);
      const list: WorkspaceSummary[] = body.workspaces ?? [];
      const next = list.find((w) => w.id === stored)?.id ?? list[0]?.id ?? null;
      setWorkspaceId(next);
    } catch {
      setUser(null);
      setWorkspaces([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const selectWorkspace = useCallback((id: string) => {
    setWorkspaceId(id);
    localStorage.setItem(STORAGE_WORKSPACE, id);
  }, []);

  const signOut = useCallback(async () => {
    await fetch("/api/auth/sign-out", { method: "POST" }).catch(() => undefined);
    localStorage.removeItem(STORAGE_WORKSPACE);
    setUser(null);
    setWorkspaces([]);
    setWorkspaceId(null);
    window.location.href = "/sign-in";
  }, []);

  const value = useMemo<SessionValue>(
    () => ({
      user,
      workspaces,
      workspace: workspaces.find((w) => w.id === workspaceId) ?? null,
      loading,
      selectWorkspace,
      refresh,
      signOut,
    }),
    [user, workspaces, workspaceId, loading, selectWorkspace, refresh, signOut],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionValue {
  const context = useContext(SessionContext);
  if (!context) throw new Error("useSession must be used within SessionProvider");
  return context;
}

/** Fetch helper that attaches the selected workspace to every platform call. */
export function workspaceFetch(
  workspaceId: string,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  return fetch(path, {
    ...init,
    headers: {
      "content-type": "application/json",
      "x-workspace-id": workspaceId,
      ...(init.headers ?? {}),
    },
  });
}

/** True when the workspace grants the permission — mirrors the server check. */
export function can(workspace: WorkspaceSummary | null, permission: string): boolean {
  if (!workspace) return false;
  const PERMISSIONS: Record<string, string[]> = {
    "connection.write": ["workspace_owner", "data_admin"],
    "connection.test": ["workspace_owner", "data_admin"],
    "discovery.run": ["workspace_owner", "data_admin"],
    // No `mapping.approve`: the server has never had such a permission, so a
    // client-only entry for it did not mirror a server check — it contradicted
    // one. Approving a mapping is enforced as `policy.approve`.
    "policy.approve": ["workspace_owner", "financial_approver"],
    "dashboard.publish": ["workspace_owner", "dashboard_publisher"],
    "sync.run": ["workspace_owner", "data_admin"],
  };
  const allowed = PERMISSIONS[permission];
  // Unknown permission fails closed, exactly as the server does.
  if (!allowed) return false;
  return workspace.roles.some((role) => allowed.includes(role));
}
