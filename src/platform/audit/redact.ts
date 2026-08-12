// Secret redaction for every log, trace, error and audit path.
//
// Two strategies, both needed:
//   • key-based  — a field NAMED like a secret is redacted whatever it holds
//   • value-based — a registered live secret value is redacted wherever it
//                   appears, including inside a string that was concatenated
//
// Value-based matters because the dangerous case is not `{apiKey: "..."}`,
// which key-based catches; it is an Odoo error string that echoed the key back.

export const REDACTED = "[redacted]";

const SECRET_KEY_PATTERN =
  /^(.*_)?(api[-_]?key|apikey|password|passwd|secret|token|authorization|auth|credential|private[-_]?key|root[-_]?key|ciphertext|session[-_]?token)(_.*)?$/i;

/**
 * Live secret values registered for the duration of an outbound call. A WeakRef
 * is not usable here (strings are primitives), so registration is explicit and
 * scoped by `withSecretRedacted`.
 */
const activeSecrets = new Set<string>();

/**
 * Registers `secret` as redactable for the duration of `fn`. Wrap every code
 * path that holds decrypted credential material.
 */
export async function withSecretRedacted<T>(secret: string, fn: () => Promise<T>): Promise<T> {
  // Very short strings would redact half the output; they are not real keys.
  const track = typeof secret === "string" && secret.length >= 8;
  if (track) activeSecrets.add(secret);
  try {
    return await fn();
  } finally {
    if (track) activeSecrets.delete(secret);
  }
}

export function redactString(input: string): string {
  let out = input;
  for (const secret of activeSecrets) {
    if (secret && out.includes(secret)) out = out.split(secret).join(REDACTED);
  }
  return out;
}

/** Deep-redacts a structure by key name and by registered value. */
export function redactSecrets<T>(value: T, depth = 0): T {
  if (depth > 8) return REDACTED as unknown as T;
  if (typeof value === "string") return redactString(value) as unknown as T;
  if (Array.isArray(value)) {
    return value.map((item) => redactSecrets(item, depth + 1)) as unknown as T;
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SECRET_KEY_PATTERN.test(key) ? REDACTED : redactSecrets(child, depth + 1);
    }
    return out as unknown as T;
  }
  return value;
}

/**
 * Sanitizes an error for a user-facing message: redacted, first line only,
 * length-capped. Odoo access errors are multi-line and chatty, and the tail
 * frequently contains internals a customer should not see.
 */
export function safeErrorMessage(error: unknown, max = 300): string {
  const raw = error instanceof Error ? error.message : String(error);
  return redactString(raw).split("\n")[0].slice(0, max);
}
