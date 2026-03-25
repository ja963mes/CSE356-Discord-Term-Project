import { Request, Response, NextFunction } from "express";
import { redis } from "../redis";

export async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const token = req.cookies?.session_token;

  if (!token) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }

  const internalId = await redis.get(`session:${token}`);

  if (!internalId) {
    res.status(401).json({ error: "Session expired or invalid" });
    return;
  }

  req.user = { internal_id: internalId };
  next();
}
