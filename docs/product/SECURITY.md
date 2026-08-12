# Security

Companion to `THREAT_MODEL.md` (what we defend against) and
`TENANCY_INVARIANTS.md` (the isolation rules). This document states the controls,
their failure behaviour, and what is knowingly still missing.

---

## 1. Controls implemented in this milestone

### Authentication
Better Auth on the existing PostgreSQL (ADR-0001). Email + password with server-
side sessions. Cookies `httpOnly`, `secure`, `sameSite=lax`. Sessions are
revocable and rotate on privilege change.

### Authorization
Two layers, neither trusted alone: PostgreSQL RLS (`FORCE`d, runtime role
`NOBYPASSRLS`, transaction-scoped `SET LOCAL app.workspace_id`) and application
membership + role checks. Workspace is resolved from the session, never from
client input.

### Secret handling
`SecretStore` interface with an AES-256-GCM envelope-encryption local adapter.
Per-secret random 96-bit IV, 128-bit auth tag, versioned key id, AAD binding the
ciphertext to its `workspace_id` and `connection_id` so a ciphertext moved
between rows fails to decrypt.

**Production guard:** if `NODE_ENV=production` and `SECRET_STORE_ADAPTER` is the
local adapter, storing a customer credential is **refused** with an explicit
error. Development convenience cannot become the production posture by accident.

Secrets are never returned by an API, logged, traced, put in an error message,
written to an audit record, or included in an AI prompt. `redactSecrets()` runs
on every log/error/audit path.

### Outbound request safety (SSRF)
`assertSafeOdooUrl()`: `https` only (`http` only for allowlisted dev hosts); no
embedded credentials; standard ports; **DNS resolved before the request** with
every resolved address checked against loopback, private v4, link-local
(including `169.254.169.254`), CGNAT, IPv6 ULA and IPv4-mapped ranges; redirects
disabled; response size and time bounded; errors surfaced generically.

### Odoo connector least privilege
Method allowlist (`authenticate`, `version`, `fields_get`, `search_count`,
`search_read`, `read`, approved `read_group`) and model allowlist, both enforced
before any network call. `create`/`write`/`unlink`/`action_*` and arbitrary
methods are refused. Stored fields preferred; non-stored computed fields need
explicit approval with tighter limits.

The customer-side integration user must be read-only. That is necessary but not
sufficient — an API key inherits its user's permissions — which is why the
connector allowlist exists as the second control.

### Audit
`audit_logs` is append-only: the runtime role has `INSERT`/`SELECT` only, and
the RLS policy grants nothing else. Credential changes, connection tests,
discovery runs and workspace membership changes are recorded with actor,
target, timestamp and redacted metadata.

### Rate limiting
Per-workspace limits on connection tests and discovery runs, with per-workspace
job serialization so one workspace cannot exhaust shared capacity.

---

## 2. Fail-open vs fail-closed

Declared in `THREAT_MODEL.md` §4. Summary: every isolation, credential and
validation control fails **closed**. The only fail-open behaviours are
*per-model discovery denial* (records a permission gap, continues) and
*last-good serving* (serves prior healthy data, badged) — both bounded and both
always visible in the UI.

---

## 3. Known gaps — stated plainly

### G-1 · The 26 legacy reporting routes are unauthenticated — HIGH
Pre-existing (audit §4.1). Any caller reaching the origin can read company
financial data. Contained today by network placement, not by the application.
Not fixed in this milestone because adding auth to live routes would break the
running dashboard; it is the **first work item after this milestone**.

### G-2 · SSRF TOCTOU
A hostname could resolve to a safe address at validation and a private one at
connect. Closed by a pinned-IP dialer in Phase 3.

### G-3 · Local secret adapter root key lives in an environment variable
Acceptable for local/staging only; the production guard enforces that. KMS/Vault
adapter is ADR-0002, Phase 3.

### G-4 · Legacy tables not yet RLS-protected
`dashboard_rows` / `dashboard_sync_state` get a nullable `workspace_id` and a
backfill in this milestone. `NOT NULL` + RLS is deferred because it is not
reversible without data loss and needs the backfill verified first.

### G-5 · No CI pipeline yet
Test commands exist and pass locally. Wiring them into CI, plus SBOM and
dependency scanning, is queued.

### G-6 · Backup/restore not proven
RPO/RTO targets are defined below but **no restore drill has been run**, so no
backup readiness is claimed.

---

## 4. Planned controls (later phases, decided now)

**Data protection.** Before any customer metadata or redacted sample reaches an
AI or trace provider: provider region, DPA, subprocessor list, no-training
setting, retention period, customer opt-out and trace location must be
configured and enforced. Deletion propagates to operational tables, caches, AI
traces, indexes/embeddings, exports and backup expiry.

**PII.** Default-deny with Arabic-name, Egyptian/Gulf phone and local-identifier
recognizers. This milestone reads **metadata only** — no records, no samples — so
the surface does not yet exist.

**Break-glass.** Platform support has no standing workspace access. Access is
audited, reason-bound, time-limited, customer-approved, auto-expiring and
notified.

**Four-eyes.** Optional second approval for high-risk financial policy changes.

**DR.** Targets for the first release: RPO ≤ 15 min, RTO ≤ 4 h, encrypted
backups, documented restore procedure, scheduled restore drills. Readiness is
claimed only after a drill passes.

**Sandboxing.** Any future generated code runs in a real sandbox
(gVisor/Firecracker/E2B) with no access to production secrets by default.

---

## 5. Credential hygiene

History of all 88 commits scanned: **no secrets found**. `.gitignore` correctly
excludes `.env` / `.env.*` and permits `.env.example`, which contains variable
names only.

No credential from any conversation, screenshot, shell history or tracked file is
copied into source. Live Railway credentials exist for the production deployment;
this milestone neither reads nor requires them, and no test, seed, script or
migration here contacts production.
