import { randomUUID } from "crypto";
import pino from "pino";
import pinoHttp from "pino-http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { env } from "./env";

/** Root logger for communities-service (JSON lines to stdout; systemd/journald friendly). */
export const logger = pino({
  name: "communities-service",
  level: env.LOG_LEVEL,
  redact: ["req.headers.cookie", "req.headers.authorization"],
});

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

/**
 * Route-level errors: pass caught value as `err` for Pino's error serializer.
 * Merges Postgres hint fields when present.
 */
export function logRouteError(message: string, err: unknown, meta?: Record<string, unknown>): void {
  const pg = pgHints(err);
  logger.error({ err, ...meta, ...(pg ? { pg } : {}) }, message);
}

/** One line per HTTP request (method, url, status, responseTime, optional userId). */
export const httpLogger = pinoHttp({
  logger,
  genReqId: (req: IncomingMessage) => {
    const h = req.headers["x-request-id"];
    if (typeof h === "string" && h.length > 0) return h;
    return randomUUID();
  },
  customProps: (req: IncomingMessage, _res: ServerResponse) => {
    const r = req as IncomingMessage & { user?: { internal_id?: string } };
    const userId = r.user?.internal_id;
    return userId ? { userId } : {};
  },
});
