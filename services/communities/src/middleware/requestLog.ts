import { randomUUID } from "crypto";
import type { Request, Response, NextFunction } from "express";
import { logInfo } from "../logger";

/**
 * Assigns `req.reqId`, logs one line per request on response finish (method, path, status, duration, optional userId).
 * Place after `cookieParser` so cookies are parsed; `req.user` is set later by `requireAuth` when present.
 */
export function requestLog(req: Request, res: Response, next: NextFunction): void {
  req.reqId = randomUUID();
  const start = Date.now();
  res.on("finish", () => {
    const ms = Date.now() - start;
    const userId = req.user?.internal_id;
    logInfo("http.request", {
      reqId: req.reqId,
      method: req.method,
      path: req.originalUrl ?? req.url,
      status: res.statusCode,
      ms,
      ...(userId ? { userId } : {}),
    });
  });
  next();
}
