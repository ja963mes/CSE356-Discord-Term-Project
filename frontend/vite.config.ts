import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      // Auth service session + OAuth redirects
      "/auth": {
        target: "http://localhost:3001",
        changeOrigin: true,
      },
      // Create-community service (POST only; max 100 created per user)
      "/create-community": {
        target: "http://localhost:3006",
        changeOrigin: true,
      },
      // Communities service (list, join, channels, members)
      "/communities": {
        target: "http://localhost:3002",
        changeOrigin: true,
      },
      // Optional legacy stub path (not implemented on communities service; client falls back)
      "/channels": {
        target: "http://localhost:3002",
        changeOrigin: true,
      },
      "/messages": {
        target: "http://localhost:3003",
        changeOrigin: true,
      },
      // Communities directory search (same service as /communities; match before /search)
      "/search-communities": {
        target: "http://localhost:3002",
        changeOrigin: true,
      },
      "/search": {
        target: "http://localhost:3004",
        changeOrigin: true,
      },
      "/dms": {
        target: "http://localhost:3007",
        changeOrigin: true,
      },
      "/ws": {
        target: "http://localhost:3005",
        changeOrigin: true,
        ws: true,
      },
    },
  },
});

