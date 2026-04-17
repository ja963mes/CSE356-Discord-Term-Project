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

app.listen(Number(env.PORT), () => {
  logger.info({ port: env.PORT }, "auth-service listening");
});