import { randomUUID } from "crypto";
import pino from "pino";
import pinoHttp from "pino-http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { env } from "./env";

export const logger = pino({
  name: "search-service",
  level: env.LOG_LEVEL,
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

export const httpLogger = pinoHttp({
  logger,
  genReqId: (req: IncomingMessage) => {
    const h = req.headers["x-request-id"];
    if (typeof h === "string" && h.length > 0) return h;
    return randomUUID();
  },
});
