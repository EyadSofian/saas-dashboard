# Threat Model — Workspace Onboarding Skeleton

Scope: the assets and flows introduced by this milestone — authentication,
workspaces, Odoo connection storage, the connection test, and metadata
discovery. Downstream phases (sync, metric engine, copilot) are noted where a
decision here constrains them.

Method: STRIDE per trust boundary, then a ranked table with the control that
answers each threat and the test that proves it.

---

## 1. Assets

| Asset | Sensitivity | Why it matters |
| --- | --- | --- |
| Odoo API keys | **Critical** | Inherit an ERP user's full permissions |
| Workspace business data | **Critical** | Customer revenue, pipeline, customers |
| Schema snapshots | High | Reveals ERP structure and customisations |
| Session tokens | High | Impersonation |
| AI prompts/responses | Medium | May carry metadata; must carry no PII/secrets |
| Audit logs | Medium | Integrity matters more than confidentiality |

## 2. Trust boundaries

```text
[Browser] ──1──▶ [TanStack server routes] ──2──▶ [PostgreSQL + RLS]
                          │                          
                          ├──3──▶ [Customer Odoo] (untrusted, customer-controlled)
                          ├──4──▶ [SecretStore]
                          └──5──▶ [AI provider] (Phase 2+)
```

1. Unauthenticated internet → application
2. Application → database (RLS enforcement point)
3. Application → arbitrary customer-supplied URL (**SSRF surface**)
4. Application → secret material (**decryption point**)
5. Application → third party (**egress surface**)

---

## 3. Ranked threats

### T1 — Cross-workspace data access · CRITICAL

*Spoofing / Information disclosure.* A user of Workspace A reads Workspace B's
data via a forged workspace id, a query missing its filter, a pooled connection
carrying stale context, a shared cache key, or a background job.

**Controls.** RLS `FORCE`d on every workspace-owned table (INV-2); runtime role
`NOBYPASSRLS`; transaction-scoped `SET LOCAL` (INV-3, INV-4); workspace resolved
from membership, never from the client (INV-5); workspace-scoped cache and job
keys (INV-6).

**Proof.** `tests/security/workspace-isolation.test.ts` — 7 surfaces plus
pool-reuse and missing-context cases.

**Residual.** A future raw query written outside the repository layer could omit
context. Mitigated by RLS being the *second* layer: even a filterless query
returns zero rows.

---

### T2 — Odoo credential compromise · CRITICAL

*Information disclosure / Elevation.* An API key leaks via database dump, log,
trace, error message, API response, or AI prompt.

**Controls.** AES-256-GCM envelope encryption; secrets stored as references
(INV-7); a `redactSecrets()` filter on all log/error paths; the connection API
returns only non-secret metadata plus a `hasSecret` boolean; a production guard
that **refuses** to store customer credentials unless a production secret-store
adapter is configured.

**Proof.** `tests/security/secret-redaction.test.ts` asserts a known key value
never appears in any API response body, log line, audit row, or error string.

**Residual.** The local dev adapter's root key lives in an env var. This is why
the production guard exists. KMS/Vault adapter is ADR-0002, Phase 3.

---

### T3 — SSRF via the Odoo URL field · HIGH

*Elevation.* The customer supplies the Odoo base URL. An attacker submits
`http://169.254.169.254/…` (cloud metadata), `http://localhost:5432`, or a
public hostname whose DNS resolves to a private address, and uses the
connection-test endpoint as a probe.

**Controls.** `assertSafeOdooUrl()` enforces: `https` only (`http` allowed only
for explicitly allowlisted dev hosts); no credentials in URL; no non-standard
ports; **DNS resolution performed before the request**, with every resolved
address checked against private/loopback/link-local/CGNAT/ULA ranges; redirects
disabled (`redirect: "manual"`); response size and time bounded; errors returned
to the user are generic and never echo response bodies.

**Proof.** `tests/security/ssrf.test.ts` covers metadata IP, localhost, private
ranges v4/v6, DNS-rebinding-shaped input, `file:`/`gopher:` schemes, embedded
credentials, and redirect-to-private.

**Residual.** TOCTOU between resolve and connect. Accepted for this milestone
and documented; the pinned-IP dialer that closes it is Phase 3.

---

### T4 — Prompt injection via Odoo metadata · HIGH (Phase 2, constrained now)

*Tampering.* A customer's Odoo field label or help text contains
"ignore previous instructions and…". Reaching the mapping model, it could cause
an invented mapping or an attempted tool call.

**Controls decided now, so Phase 2 inherits them.** Metadata is always
delimited as data, never concatenated into instructions. The mapping model gets
**no tools, no network, no secrets, no write capability**. Every model-selected
path is validated against the frozen schema snapshot; invented paths are
rejected. Every mapping requires human approval in V1.

**Proof.** Adversarial `x_` field fixtures in the discovery fixtures already
carry injection strings, so the snapshot layer is exercised today.

---

### T5 — Unauthenticated access to existing reporting routes · HIGH (pre-existing)

The 26 existing `/api/*` routes have no authentication (audit §4.1). This
milestone does not change them — doing so would break the live dashboard — but
it is the highest-severity pre-existing issue and is scheduled as the first work
after this milestone.

**Interim control.** All *new* workspace routes are authenticated and
membership-checked. Documented in `SECURITY.md` §"Known gaps".

---

### T6 — Malicious/compromised Odoo responds abusively · MEDIUM

*DoS.* A hostile endpoint returns a 10 GB body, hangs, or redirects in a loop.

**Controls.** Per-call timeouts (15 s connection test, 30 s discovery), response
size cap, bounded retries with exponential backoff, per-workspace concurrency
and rate limits, resumable discovery with a checkpoint so a timeout does not
restart the scan.

---

### T7 — Privilege escalation through the connector · MEDIUM

*Elevation.* Today `odooCall()` forwards any model/method to `execute_kw`
(audit §4.3) — a write primitive against the customer's ERP.

**Controls.** The new `SafeOdooConnector` exposes only `authenticate`,
`version`, `fields_get`, `search_count`, `search_read`, `read`, and approved
`read_group`. Model names are checked against the discovery allowlist; methods
against a literal allowlist. `create`/`write`/`unlink`/`action_*`/arbitrary
methods are rejected before any network call.

**Proof.** `tests/security/connector-allowlist.test.ts` asserts each forbidden
method and each off-allowlist model is refused without a request being made.

---

### T8 — PII leaving the platform · MEDIUM (Phase 2, policy set now)

Profiling could ship customer names, emails, phones to an AI provider.

**Controls.** Default-deny: this milestone's discovery reads **metadata only** —
model names, field names, labels, types, relations, selection values. It reads
no records and computes no samples. Profiling with Arabic/Gulf-aware redaction
arrives in Phase 2 behind an egress policy check.

---

### T9 — Audit log tampering · LOW

**Controls.** `audit_logs` is append-only: no `UPDATE`/`DELETE` grant to the
runtime role, enforced by grant and by an RLS policy permitting `INSERT` and
`SELECT` only.

---

### T10 — Session attacks · MEDIUM

**Controls (Better Auth defaults, verified).** `httpOnly`, `secure`,
`sameSite=lax` cookies; server-side session records revocable on demand; session
rotation on privilege change; CSRF protection on state-changing routes.

---

## 4. Explicit fail-open / fail-closed declarations

| Control | Behaviour on failure | Rationale |
| --- | --- | --- |
| RLS workspace context | **Fail closed** (0 rows) | Isolation is critical |
| Membership check | **Fail closed** (403) | Isolation is critical |
| SecretStore decrypt | **Fail closed** (connection unusable) | No silent plaintext path |
| Production secret-store guard | **Fail closed** (refuse to store) | Never store customer creds unsafely |
| SSRF URL validation | **Fail closed** (reject) | Cannot verify ⇒ do not call |
| Connector method allowlist | **Fail closed** (reject) | Unknown method ⇒ no call |
| Odoo discovery of one model | **Fail open, recorded** | Records a `PermissionGap`, continues other models — a restricted model must not fail the whole scan |
| Last-good snapshot serving | **Fail open, badged** | Serving healthy prior data beats blanking, provided the failure is visible |

The two fail-open cases are deliberate, bounded, and always surfaced in the UI.

---

## 5. Out of scope for this milestone

Billing fraud, SSO/SAML, DDoS at the edge, supply-chain compromise of pinned
dependencies, physical/cloud-provider compromise, and the Phase 3+ sync and
copilot surfaces. Each is tracked in `ROADMAP.md`.
