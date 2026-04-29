/// <reference path="./types/express.d.ts" />
import express, { Request, Response, NextFunction } from "express";
import cookieParser from "cookie-parser";
import path from "path";
import { env } from "./config/env";
import authRouter from "./routes/auth";
import { requireAuth } from "./middleware/session";
import { httpLogger, logRouteError, logger } from "./logger";

const app = express();

app.use(express.json());
// Accept form-encoded posts too (some clients/proxies omit JSON Content-Type).
app.use(express.urlencoded({ extended: false }));
app.use(cookieParser());
app.use(httpLogger);

app.use("/auth/avatars", express.static(path.join(__dirname, "../uploads/avatars")));

app.use("/auth", authRouter);

// Session probe for frontend route guards.
app.get("/auth/me", requireAuth, (req, res) => {
  res.json({ internal_id: req.user!.internal_id });
});

// Serve the OAuth pending page through the login page
app.get("/auth/oauth/pending", (_req, res) => {
  res.sendFile(path.join(__dirname, "../public/login.html"));
});

// Protected landing page
app.get("/", requireAuth, (_req, res) => {
  res.sendFile(path.join(__dirname, "../public/home.html"));
});

// Redirect unauthenticated users to login
app.get("/", (_req, res) => {
  res.redirect("/login.html");
});

app.use(express.static(path.join(__dirname, "../public")));

app.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "auth-service" });
});

app.post("/internal/log-level", (req, res) => {
  const { level } = req.body as { level?: string };
  const valid = ["trace", "debug", "info", "warn", "error", "fatal"];
  if (!level || !valid.includes(level)) {
    res.status(400).json({ error: `level must be one of: ${valid.join(", ")}` });
    return;
  }
  logger.level = level;
  res.json({ level: logger.level });
});

app.use((err: unknown, req: Request, res: Response, next: NextFunction) => {
  if (res.headersSent) {
    next(err);
    return;
  }
  logRouteError("Unhandled auth service error", err, {
    reqId: req.id,
    method: req.method,
    path: req.path,
  });
  res.status(500).json({ error: "Internal server error" });
});

const server = app.listen(Number(env.PORT), () => {
  logger.info({ port: env.PORT }, "auth-service listening");
});
// keepAliveTimeout > nginx upstream keepalive_timeout (60s default) + headersTimeout > keepAliveTimeout
// Prevents ERR_INCOMPLETE_CHUNKED_ENCODING when nginx reuses a socket Node just closed.
server.keepAliveTimeout = 65_000;
server.headersTimeout = 66_000;