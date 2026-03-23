import express from "express";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "search-service" });
});

// Placeholder search endpoint for the wireframe search bar.
app.get("/search", (req, res) => {
  const q = String(req.query.q ?? "");
  res.json({
    query: q,
    results: [
      { id: "s1", type: "message", title: "Welcome to the sanctuary", snippet: "Welcome to the sanctuary.", score: 1.0 },
    ],
  });
});

const port = Number(process.env.PORT ?? 3004);
app.listen(port, () => {
  console.log(`Search service running on port ${port}`);
});

