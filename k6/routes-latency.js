/**
 * Per-route latency smoke / load test (k6).
 *
 * Install: https://k6.io/docs/get-started/installation/
 * Run from repo root:
 *   k6 run k6/routes-latency.js
 *
 * Env overrides (optional):
 *   AUTH_URL=http://127.0.0.1:3001 COMMUNITIES_URL=http://127.0.0.1:3002 \
 *   SEARCH_URL=http://127.0.0.1:3004 MESSAGES_URL=http://127.0.0.1:3003 \
 *   VUS=10 DURATION=60s k6 run k6/routes-latency.js
 *
 * Tighten thresholds after you have a baseline:
 *   P95_MS_AUTH=500 P95_MS_COMMUNITIES=800 P95_MS_SEARCH=2000 P95_MS_MESSAGES=500 \
 *   k6 run k6/routes-latency.js
 */
import http from "k6/http";
import { check } from "k6";

const authUrl = __ENV.AUTH_URL || "http://127.0.0.1:3001";
const communitiesUrl = __ENV.COMMUNITIES_URL || "http://127.0.0.1:3002";
const searchUrl = __ENV.SEARCH_URL || "http://127.0.0.1:3004";
const messagesUrl = __ENV.MESSAGES_URL || "http://127.0.0.1:3003";

const vus = Number(__ENV.VUS || 5);
const duration = __ENV.DURATION || "30s";

const p95Auth = __ENV.P95_MS_AUTH || "2000";
const p95Communities = __ENV.P95_MS_COMMUNITIES || "3000";
const p95Search = __ENV.P95_MS_SEARCH || "5000";
const p95Messages = __ENV.P95_MS_MESSAGES || "2000";

export const options = {
  scenarios: {
    auth_health: {
      executor: "constant-vus",
      vus,
      duration,
      exec: "authHealth",
      tags: { route: "auth_health" },
    },
    communities_search_directory: {
      executor: "constant-vus",
      vus,
      duration,
      exec: "communitiesSearchDirectory",
      tags: { route: "search_communities" },
      startTime: "2s",
    },
    search_service_health: {
      executor: "constant-vus",
      vus,
      duration,
      exec: "searchServiceHealth",
      tags: { route: "search_health" },
      startTime: "4s",
    },
    messages_health: {
      executor: "constant-vus",
      vus,
      duration,
      exec: "messagesHealth",
      tags: { route: "messages_health" },
      startTime: "6s",
    },
  },
  thresholds: {
    http_req_failed: ["rate<0.05"],
    "http_req_duration{route:auth_health}": [`p(95)<${p95Auth}`],
    "http_req_duration{route:search_communities}": [`p(95)<${p95Communities}`],
    "http_req_duration{route:search_health}": [`p(95)<${p95Search}`],
    "http_req_duration{route:messages_health}": [`p(95)<${p95Messages}`],
  },
};

export function authHealth() {
  const res = http.get(`${authUrl}/health`, {
    tags: { route: "auth_health" },
  });
  check(res, { "auth /health 2xx": (r) => r.status >= 200 && r.status < 300 });
}

export function communitiesSearchDirectory() {
  // Random query suffix reduces one-key cache dominance so you see DB + cache mix.
  const q = `latency-test-${__VU}-${Date.now()}`;
  const url = `${communitiesUrl}/search-communities?q=${encodeURIComponent(q)}&limit=25`;
  const res = http.get(url, {
    tags: { route: "search_communities" },
  });
  check(res, {
    "search-communities 2xx": (r) => r.status >= 200 && r.status < 300,
  });
}

export function searchServiceHealth() {
  const res = http.get(`${searchUrl}/health`, {
    tags: { route: "search_health" },
  });
  check(res, {
    "search /health 2xx": (r) => r.status >= 200 && r.status < 300,
  });
}

export function messagesHealth() {
  const res = http.get(`${messagesUrl}/health`, {
    tags: { route: "messages_health" },
  });
  check(res, {
    "messages /health 2xx": (r) => r.status >= 200 && r.status < 300,
  });
}
