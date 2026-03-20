import express from "express";
import cookieParser from "cookie-parser";
import path from "path";
import { env } from "./config/env";
import authRouter from "./routes/auth";
import { requireAuth } from "./middleware/session";

const app = express();

app.use(express.json());
app.use(cookieParser());

app.use("/auth", authRouter);

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

app.listen(Number(env.PORT), () => {
  console.log(`Auth service running on port ${env.PORT}`);
});