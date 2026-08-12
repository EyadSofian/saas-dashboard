// Contract surface. This module imports from nothing else in `src/platform`
// (ADR-0006), so it can be loaded by any layer without a cycle.
export * from "./canonical";
export * from "./workspace";
export * from "./odoo";
export * from "./schema-snapshot";
export * from "./audit";
