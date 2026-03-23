import express from "express";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "communities-service" });
});

// Placeholder endpoints for the frontend wireframes.
app.get("/channels", (_req, res) => {
  res.json({
    channels: [
      { id: "general-chat", name: "general-chat", type: "text" },
      { id: "design-critique", name: "design-critique", type: "text" },
      { id: "resources", name: "resources", type: "text" },
      { id: "main-lounge", name: "Main Lounge", type: "voice" },
      { id: "pair-programming", name: "Pair Programming", type: "voice" },
    ],
  });
});

const port = Number(process.env.PORT ?? 3002);
app.listen(port, () => {
  console.log(`Communities service running on port ${port}`);
});

