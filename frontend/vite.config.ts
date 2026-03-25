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
      // Stubbed microservices for the wireframe UI
      "/channels": {
        target: "http://localhost:3002",
        changeOrigin: true,
      },
      "/messages": {
        target: "http://localhost:3003",
        changeOrigin: true,
      },
      "/search": {
        target: "http://localhost:3004",
        changeOrigin: true,
      },
      "/dms": {
        target: "http://localhost:3005",
        changeOrigin: true,
      },
    },
  },
});

