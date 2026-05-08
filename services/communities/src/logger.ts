import { randomUUID } from "crypto";
import pino from "pino";
import pinoHttp from "pino-http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { env } from "./env";

/** Client IP when behind nginx (avoids logging full header blobs). */
function clientIp(req: IncomingMessage): string | undefined {
  const xff = req.headers["x-forwarded-for"];
  const real = req.headers["x-real-ip"];
  if (typeof xff === "string" && xff.length > 0) return xff.split(",")[0]?.trim();
  if (typeof real === "string" && real.length > 0) return real;
  return req.socket?.remoteAddress ?? undefined;
}

/** Slim HTTP access fields — full req/res headers are too noisy for journalctl/tail. */
function serializeReq(req: IncomingMessage): Record<string, unknown> {
  const r = req as IncomingMessage & { id?: string };
  return {
    id: r.id,
    method: req.method,
    url: req.url,
    ip: clientIp(req),
  };
}

function serializeRes(res: ServerResponse): Record<string, unknown> {
  return { statusCode: res.statusCode };
}

/** Root logger for communities-service (JSON lines to stdout; systemd/journald friendly). */
export const logger = pino({
  name: "communities-service",
  level: env.LOG_LEVEL,
  redact: ["req.headers.cookie", "req.headers.authorization"],
  serializers: {
    req: serializeReq,
    res: serializeRes,
  },
  ...(env.LOG_PRETTY
    ? {
        transport: {
          target: "pino-pretty",
          options: {
            colorize: false,
            singleLine: true,
            translateTime: "SYS:standard",
            ignore: "pid,hostname",
          },
        },
      }
    : {}),
});

/** Postgres / driver errors often expose these fields (libpq / node-pg). */
function pgHints(err: unknown): Record<string, unknown> | undefined {
  if (!err || typeof err !== "object") return undefined;
  const o = err as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of [
    "code",
    "constraint",
    "detail",
    "table",
    "column",
    "routine",
    "schema",
    "severity",
    "where",
    "hint",
    "position",
  ]) {
    if (k in o && o[k] != null) out[k] = o[k];
  }
  return Object.keys(out).length ? out : undefined;
}

function errnoMeta(err: unknown): Record<string, unknown> | undefined {
  if (!err || typeof err !== "object") return undefined;
  const e = err as NodeJS.ErrnoException;
  if (e.code == null && e.syscall == null) return undefined;
  const out: Record<string, unknown> = {};
  if (e.code != null) out.errnoCode = e.code;
  if (e.syscall != null) out.syscall = e.syscall;
  if (e.errno != null) out.errno = e.errno;
  return out;
}

/**
 * Route-level errors: structured for journalctl / grep (`pg.*`, `errnoCode`, stack).
 * Keeps `err` for Pino's built-in Error serializer when value is an Error.
 */
export function logRouteError(message: string, err: unknown, meta?: Record<string, unknown>): void {
  const pg = pgHints(err);
  const sys = errnoMeta(err);
  logger.error({ err, ...meta, ...(pg ? { pg } : {}), ...(sys ?? {}) }, message);
}

/** One line per HTTP request (method, url, status, responseTime, optional userId). */
export const httpLogger = pinoHttp({
  logger,
  /** pino-http builds a child logger; without this it uses verbose std-serializers for req/res. */
  serializers: {
    req: serializeReq,
    res: serializeRes,
  },
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
