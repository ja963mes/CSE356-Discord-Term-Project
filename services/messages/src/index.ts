import express from "express";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "messages-service" });
});

// Placeholder endpoint for channel history.
app.get("/messages", (req, res) => {
  const channelId = String(req.query.channelId ?? "general-chat");
  res.json({
    channelId,
    messages: [
      { id: "m1", author: "Neo_Architect", content: "Welcome to the sanctuary.", ts: new Date().toISOString() },
      { id: "m2", author: "Guest", content: "Design critique starts soon.", ts: new Date().toISOString() },
    ],
  });
});

const port = Number(process.env.PORT ?? 3003);
app.listen(port, () => {
  console.log(`Messages service running on port ${port}`);
});

