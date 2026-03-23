import express from "express";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "realtime-service" });
});

// Placeholder for future DM transport (WebSocket or SSE).
app.get("/dms/sse", (_req, res) => {
  res.status(501).json({ error: "Not implemented yet" });
});

const port = Number(process.env.PORT ?? 3005);
app.listen(port, () => {
  console.log(`Realtime service running on port ${port}`);
});

