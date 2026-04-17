import pino from "pino";
import { env } from "./env";

export const logger = pino({
  name: "realtime-service",
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

