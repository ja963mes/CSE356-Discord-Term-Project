import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const apiOrigin = (env.VITE_API_ORIGIN || "http://localhost").replace(/\/+$/, "");
  const authTarget = env.VITE_AUTH_ORIGIN || `${apiOrigin}:3001`;
  const communitiesTarget = env.VITE_COMMUNITIES_ORIGIN || `${apiOrigin}:3002`;
  const messagesTarget = env.VITE_MESSAGES_ORIGIN || `${apiOrigin}:3003`;
  const searchTarget = env.VITE_SEARCH_ORIGIN || `${apiOrigin}:3004`;
  const realtimeTarget = env.VITE_REALTIME_ORIGIN || `${apiOrigin}:3005`;
  const dmsTarget = env.VITE_DMS_ORIGIN || `${apiOrigin}:3007`;
  const readStateTarget = env.VITE_READ_STATE_ORIGIN || `${apiOrigin}:3008`;

  return {
  plugins: [react()],
  server: {
	allowedHosts: true,
    proxy: {
      // Auth service session + OAuth redirects
      "/auth": {
        target: authTarget,
        changeOrigin: true,
      },
      // Communities service: list, join, channels, members, POST /create-community
      "/create-community": {
        target: communitiesTarget,
        changeOrigin: true,
      },
      "/communities": {
        target: communitiesTarget,
        changeOrigin: true,
      },
      // Optional legacy stub path (not implemented on communities service; client falls back)
      "/channels": {
        target: communitiesTarget,
        changeOrigin: true,
      },
      "/messages": {
        target: messagesTarget,
        changeOrigin: true,
      },
      // MinIO presign for guild channel attachments (messages service)
      "/attachments": {
        target: messagesTarget,
        changeOrigin: true,
      },
      // Communities directory search (same service as /communities; match before /search)
      "/search-communities": {
        target: communitiesTarget,
        changeOrigin: true,
      },
      "/search": {
        target: searchTarget,
        changeOrigin: true,
      },
      "/dms": {
        target: dmsTarget,
        changeOrigin: true,
      },
      "/read-state": {
        target: readStateTarget,
        changeOrigin: true,
      },
      "/ws": {
        target: realtimeTarget,
        changeOrigin: true,
        ws: true,
      },
    },
  },
  };
});
