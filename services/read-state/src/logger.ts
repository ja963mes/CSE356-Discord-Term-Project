import { randomUUID } from "crypto";
import pino from "pino";
import pinoHttp from "pino-http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { env } from "./env";

function clientIp(req: IncomingMessage): string | undefined {
  const xff = req.headers["x-forwarded-for"];
  const real = req.headers["x-real-ip"];
  if (typeof xff === "string" && xff.length > 0) return xff.split(",")[0]?.trim();
  if (typeof real === "string" && real.length > 0) return real;
  return req.socket?.remoteAddress ?? undefined;
}

function serializeReq(req: IncomingMessage): Record<string, unknown> {
  const r = req as IncomingMessage & { id?: string };
  return { id: r.id, method: req.method, url: req.url, ip: clientIp(req) };
}

function serializeRes(res: ServerResponse): Record<string, unknown> {
  return { statusCode: res.statusCode };
}

export const logger = pino({
  name: "read-state-service",
  level: env.LOG_LEVEL,
  redact: ["req.headers.cookie", "req.headers.authorization"],
  serializers: { req: serializeReq, res: serializeRes },
  ...(env.LOG_PRETTY
    ? {
        transport: {
          target: "pino-pretty",
          options: { colorize: false, singleLine: true, translateTime: "SYS:standard", ignore: "pid,hostname" },
        },
      }
    : {}),
});

export const httpLogger = pinoHttp({
  logger,
  serializers: { req: serializeReq, res: serializeRes },
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

export function logRouteError(message: string, err: unknown, meta?: Record<string, unknown>): void {
  const o = err && typeof err === "object" ? (err as Record<string, unknown>) : {};
  const pg: Record<string, unknown> = {};
  for (const k of ["code", "constraint", "detail", "table", "column", "routine", "severity", "hint"]) {
    if (k in o && o[k] != null) pg[k] = o[k];
  }
  const e = err as NodeJS.ErrnoException;
  const sys = e?.code != null || e?.syscall != null
    ? { errnoCode: e.code, syscall: e.syscall, errno: e.errno }
    : undefined;
  logger.error({ err, ...meta, ...(Object.keys(pg).length ? { pg } : {}), ...(sys ?? {}) }, message);
}
