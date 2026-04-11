#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
OUT_DIR="$ROOT_DIR/diagnostics"
mkdir -p "$OUT_DIR"

TS="$(date +%Y%m%d-%H%M%S)"
OUT_FILE="$OUT_DIR/local-diagnostics-$TS.txt"

print_host_overview() {
  echo "=== host overview ==="
  uname -a || true
  uptime || true
  echo
}

print_top_processes() {
  echo "=== top processes by cpu ==="
  ps -Ao pid,ppid,%cpu,%mem,rss,command | sort -k3 -nr | awk 'NR==1 || NR<=21 { print }' || echo "ps cpu snapshot failed"
  echo
  echo "=== top processes by memory ==="
  ps -Ao pid,ppid,%cpu,%mem,rss,command | sort -k4 -nr | awk 'NR==1 || NR<=21 { print }' || echo "ps memory snapshot failed"
  echo
}

print_node_processes() {
  echo "=== node/npm/vite processes ==="
  if command -v rg >/dev/null 2>&1; then
    ps -Ao pid,ppid,%cpu,%mem,rss,command | rg "node|npm|ts-node|nodemon|vite" | rg -v rg || true
  else
    ps -Ao pid,ppid,%cpu,%mem,rss,command | awk '/node|npm|ts-node|nodemon|vite/ { print }' || true
  fi
  echo
}

print_docker_profile() {
  echo "=== docker stats ==="
  docker stats --no-stream || { echo "docker stats failed"; echo; return; }
  echo

  echo "=== docker container limits (cpu/memory) ==="
  docker ps --format '{{.Names}}' | while read -r name; do
    [ -z "$name" ] && continue
    docker inspect "$name" --format 'name={{.Name}} mem_limit={{.HostConfig.Memory}} cpu_quota={{.HostConfig.CpuQuota}} cpu_period={{.HostConfig.CpuPeriod}} nano_cpus={{.HostConfig.NanoCpus}} cpuset={{.HostConfig.CpusetCpus}}' || true
  done
  echo

  echo "=== docker service status ==="
  docker ps --format 'table {{.Names}}\t{{.Status}}\t{{.RunningFor}}\t{{.Ports}}' || echo "docker ps failed"
  echo

  echo "=== docker system df ==="
  docker system df || echo "docker system df failed"
  echo
}

{
  echo "=== timestamp ==="
  date
  echo

  print_host_overview
  print_top_processes
  print_node_processes

  if command -v docker >/dev/null 2>&1; then
    print_docker_profile
  else
    echo "docker not installed"
    echo
  fi

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
