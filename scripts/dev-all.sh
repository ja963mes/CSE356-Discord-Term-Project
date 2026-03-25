#!/usr/bin/env bash
# Start auth, stub microservices, and the React frontend together (parallel).
set -euo pipefail

cd "$(dirname "$0")/.."
exec npm run dev:all

