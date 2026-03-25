#!/usr/bin/env bash
# Start auth, stub microservices, and the React frontend in parallel (same as `npm run dev:all`).
set -euo pipefail
cd "$(dirname "$0")/.."
exec npm run dev:all
