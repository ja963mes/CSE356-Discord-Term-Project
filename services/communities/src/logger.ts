/** Structured logging for communities-service (single prefix, optional JSON fields). */

const PREFIX = "[communities]";

function safeJson(meta: Record<string, unknown>): string {
  try {
    return JSON.stringify(meta);
  } catch {
    return "{}";
  }
}

/** Postgres / Drizzle errors often expose these fields. */
function pgHints(err: unknown): Record<string, unknown> | undefined {
  if (!err || typeof err !== "object") return undefined;
  const o = err as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of ["code", "constraint", "detail", "table", "column", "routine"]) {
    if (k in o && o[k] != null) out[k] = o[k];
  }
  return Object.keys(out).length ? out : undefined;
}

export function logInfo(message: string, meta?: Record<string, unknown>): void {
  if (meta && Object.keys(meta).length > 0) {
    console.log(`${PREFIX} ${message}`, safeJson(meta));
  } else {
    console.log(`${PREFIX} ${message}`);
  }
}

export function logWarn(message: string, meta?: Record<string, unknown>): void {
  if (meta && Object.keys(meta).length > 0) {
    console.warn(`${PREFIX} ${message}`, safeJson(meta));
  } else {
    console.warn(`${PREFIX} ${message}`);
  }
}

/**
 * Log an error with optional route/context. Pass the caught value as `err`.
 * Includes Postgres hint fields when present (unique violations, FK, etc.).
 */
export function logError(message: string, err: unknown, meta?: Record<string, unknown>): void {
  const pg = pgHints(err);
  const combined = { ...meta, ...(pg ? { pg } : {}) };
  if (Object.keys(combined).length > 0) {
    console.error(`${PREFIX} ${message}`, safeJson(combined), err);
  } else {
    console.error(`${PREFIX} ${message}`, err);
  }
}
