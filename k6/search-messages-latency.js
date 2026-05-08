/**
 * Latency test for GET /search/messages (search microservice, requires session).
 *
 * Prerequisites:
 *   - Search service + Postgres + Redis + Elasticsearch running
 *   - Valid session: log in via browser, copy `session_token` cookie value
 *   - COMMUNITY_ID: a community UUID the user belongs to (with channel access)
 *
 * Run:
 *   SESSION_TOKEN=... COMMUNITY_ID=00000000-0000-4000-8000-000000000001 \
 *   k6 run k6/search-messages-latency.js
 *
 * Optional env:
 *   SEARCH_URL=http://127.0.0.1:3004 SEARCH_Q=hello VUS=5 DURATION=30s
 *   P95_MS_SEARCH_MESSAGES=3000
 */
import http from "k6/http";
import { check } from "k6";

const token = __ENV.SESSION_TOKEN;
const communityId = __ENV.COMMUNITY_ID;
const searchUrl = __ENV.SEARCH_URL || "http://127.0.0.1:3004";
const q = __ENV.SEARCH_Q || "test";
const vus = Number(__ENV.VUS || 5);
const duration = __ENV.DURATION || "30s";
const p95 = __ENV.P95_MS_SEARCH_MESSAGES || "5000";

if (!token || !communityId) {
  throw new Error("Set SESSION_TOKEN (session_token cookie value) and COMMUNITY_ID (UUID)");
}

const cookieHeader = `session_token=${token}`;

export const options = {
  scenarios: {
    search_messages_community: {
      executor: "constant-vus",
      vus,
      duration,
      exec: "searchMessages",
      tags: { route: "search_messages" },
    },
  },
  thresholds: {
    http_req_failed: ["rate<0.05"],
    "http_req_duration{route:search_messages}": [`p(95)<${p95}`],
  },
};

export function searchMessages() {
  const params = new URLSearchParams({
    q,
    scope: "community",
    communityId,
    limit: "25",
    offset: "0",
  });
  const url = `${searchUrl}/search/messages?${params.toString()}`;
  const res = http.get(url, {
    headers: { Cookie: cookieHeader },
    tags: { route: "search_messages" },
  });
  check(res, {
    "search/messages 2xx": (r) => r.status >= 200 && r.status < 300,
  });
}
