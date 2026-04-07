#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
OUT_DIR="$ROOT_DIR/diagnostics"
mkdir -p "$OUT_DIR"

TS="$(date +%Y%m%d-%H%M%S)"
OUT_FILE="$OUT_DIR/local-diagnostics-$TS.txt"

{
  echo "=== timestamp ==="
  date
  echo

  echo "=== docker stats ==="
  if command -v docker >/dev/null 2>&1; then
    docker stats --no-stream || echo "docker stats failed"
  else
    echo "docker not installed"
  fi
  echo

  echo "=== docker system df ==="
  if command -v docker >/dev/null 2>&1; then
    docker system df || echo "docker system df failed"
  else
    echo "docker not installed"
  fi
  echo

  echo "=== node/vite processes ==="
  if command -v rg >/dev/null 2>&1; then
    ps aux | rg "node|ts-node|nodemon|vite" | rg -v rg || true
  else
    ps aux | awk '/node|ts-node|nodemon|vite/ { print }' || true
  fi
  echo

  echo "=== repo disk ==="
  du -sh "$ROOT_DIR"
  echo

  echo "=== top dirs ==="
  (
    cd "$ROOT_DIR"
    du -sh * 2>/dev/null | sort -h
  )
} >"$OUT_FILE"

echo "Diagnostics written: $OUT_FILE"
