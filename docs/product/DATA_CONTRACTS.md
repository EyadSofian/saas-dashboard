# Data Contracts

Every contract crossing a module or process boundary is a Zod schema in
`src/platform/contracts/`, validated at the boundary and versioned. Unknown
fields are rejected (`.strict()`); unknown operators fail closed.

Contracts implemented in this milestone are marked **v1**. Contracts the master
specification defines for later phases are marked **planned** and are recorded
here so Phase 2 does not re-litigate their shape.

---

## 1. Versioning and hashing

- Every persisted contract carries `contractVersion` (integer, starts at 1).
- An incompatible `contractVersion` **fails closed** — never best-effort parsed.
- Canonical serialization: keys sorted, no insignificant whitespace, UTF-8 NFC.
- Hash: `sha256(canonicalJson(value))`, lowercase hex. Used for snapshot dedupe
  and AI-input caching.

`canonicalJson` already exists in the codebase (`dashboard-db.server.ts:134`)
and is lifted into `src/platform/contracts/canonical.ts` unchanged, so hashing
behaves identically on both sides of the migration.

---

## 2. Implemented in this milestone (v1)

### `OdooConnectionInput`

Submitted by the onboarding wizard. The API key is write-only: it is accepted,
encrypted, and never returned.

```ts
{
  baseUrl: string;   // https, host-validated, no credentials, no private IP
  database: string;  // 1..128, no control characters
  login: string;     // 1..256
  apiKey: string;    // 1..512, NEVER echoed back
}
```

### `ConnectionTestResult`

```ts
{
  ok: boolean;
  state: "success" | "invalid_url" | "unreachable" | "auth_failed"
       | "access_denied" | "timeout" | "blocked_target" | "not_configured";
  serverVersion?: string;   // from common.version
  uid?: number;             // presence proves auth; not a secret
  probes: PermissionProbe[];
  message: { ar: string; en: string };  // safe copy, never echoes Odoo internals
  checkedAt: string;        // ISO-8601 UTC
}
```

### `PermissionProbe`

One per allowlisted model. A denial is data, not an error.

```ts
{
  model: string;
  canRead: boolean;
  canCount: boolean;
  fieldCount: number | null;
  recordCount: number | null;   // search_count only; no records read
  gap: PermissionGap | null;
}
```

### `PermissionGap`

```ts
{
  model: string;
  operation: "read" | "fields_get" | "search_count" | "search_read" | "read_group";
  reason: "access_denied" | "model_missing" | "timeout" | "error";
  detail: string;              // sanitized, ≤300 chars, first line only
  observedAt: string;
}
```

### `SchemaSnapshot` / `SchemaModel` / `SchemaField` / `SchemaRelation`

The frozen description of one customer's Odoo, and the only thing a future
mapping model is allowed to select from.

```ts
SchemaSnapshot {
  id: string;                  // uuid
  workspaceId: string;
  connectionId: string;
  contractVersion: 1;
  odooVersion: string | null;
  contentHash: string;         // sha256 of canonical models+fields+relations
  modelCount: number;
  fieldCount: number;
  relationCount: number;
  permissionGaps: PermissionGap[];
  status: "discovering" | "ready" | "failed";
  startedAt: string;
  completedAt: string | null;
}

SchemaField {
  model: string;
  name: string;                // technical name, e.g. x_campaign_name
  label: string;               // translated label — UNTRUSTED DATA
  help: string | null;         // UNTRUSTED DATA
  type: OdooFieldType;
  relation: string | null;
  relationField: string | null;
  required: boolean;
  readonly: boolean;
  stored: boolean;
  computed: boolean;
  isCustom: boolean;           // name starts with x_ or Studio-managed
  selectionValues: Array<{ value: string; label: string }> | null;
}
```

`label` and `help` are customer-controlled strings. Everything downstream treats
them as data: they are delimited, never interpolated into instructions, and
never used to construct a query path.

### `WorkspaceContext`

```ts
{ workspaceId: string; organizationId: string; userId: string; roles: Role[] }
```

Resolved from the session + membership. Never constructed from request input.

### `AuditEvent`

```ts
{
  workspaceId: string;
  actorUserId: string | null;   // null = system/job
  action: string;               // e.g. "connection.created"
  targetType: string;
  targetId: string | null;
  metadata: Record<string, unknown>;  // passed through redactSecrets()
  occurredAt: string;
}
```

Append-only. `metadata` is redacted before write, not before read.

### `DataHealthState`

```ts
{
  workspaceId: string;
  domain: string;
  status: "never" | "success" | "stale" | "failed";
  lastSuccessAt: string | null;   // advances ONLY on success
  lastAttemptAt: string | null;   // advances on every attempt
  lastError: string | null;
  rowCount: number | null;
}
```

The two timestamps are separate precisely so a failed attempt can be shown
without corrupting freshness — the defect found in audit §4.5.

---

## 3. Planned (Phase 2+) — shape fixed now

`ModuleInventory`, `SemanticMappingProposal`, `EntityMapping`, `FieldMapping`,
`RelationMapping`, `ReportingPolicyProposal`, `BusinessQuestion`,
`QualityRuleProposal`, `MetricDefinition`, `DashboardBlueprint`, `Evidence`,
`MappingAlternative`, `LineageRef` — as specified in the master specification
§7, to be authored as Zod schemas before any compiler work begins.

### AST safety rules (binding on Phase 4)

`TransformAst`, `MetricAggregationAst` and `MetricFilterAst` are **data, never
code**. No `eval`, no function strings, no SQL fragments.

- Operator allowlist, closed set, versioned.
- Max depth 8; max 64 nodes per expression.
- Every leaf referencing a field must resolve inside the pinned schema snapshot.
- Unknown operator ⇒ reject the whole manifest.

### Fan-out policy (binding on Phase 4)

Every `MetricDefinition` declares `fanoutPolicy`:
`forbid` | `aggregate_before_join` | `distinct_entity`. The planner validates
entity grain and relationship cardinality *before* emitting a plan, so an
invoice total cannot multiply through invoice lines.

### Metric response envelope

Already fixed, because the existing `metric-catalog.ts` proves the UI needs it:

```ts
{
  metricKey: string;
  value: number | null;          // null = unavailable, never a fabricated 0
  isAvailable: boolean;
  unavailableReason?: string;
  unit: "count" | "currency" | "percent" | "duration" | "number";
  coverage: { ratio: number; warnings: string[] };
  dataWatermark: string;
  mappingVersion: number;
  metricVersion: number;
  datePolicy: string;
  lineageRef: string;
}
```

---

## 4. Date semantics (binding everywhere)

Ranges are **half-open**: `[from, to)` in the workspace timezone. The UI may
show an inclusive end date but must convert to the exclusive next-day boundary
before querying. The server converts to UTC exactly once and echoes the policy
in the response.
