#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
THRESHOLD="${CPU_THRESHOLD_PERCENT:-50}"
INTERVAL="${CPU_POLL_INTERVAL_SEC:-5}"

cpu_usage_percent() {
  case "$(uname -s)" in
    Darwin)
      # Example: "CPU usage: 7.65% user, 9.43% sys, 82.91% idle"
      top -l 1 | awk -F'[,:% ]+' '/CPU usage/ { printf("%.2f", 100 - $10); exit }'
      ;;
    Linux)
      # Example: "%Cpu(s):  1.2 us,  0.4 sy, ... 98.1 id, ..."
      top -bn1 | awk -F'[, ]+' '/^%?Cpu\(s\)/ { for (i=1; i<=NF; i++) if ($i=="id") { printf("%.2f", 100 - $(i-1)); exit } }'
      ;;
    *)
      echo "Unsupported OS: $(uname -s)" >&2
      exit 1
      ;;
  esac
}

echo "Watching CPU usage every ${INTERVAL}s (threshold: ${THRESHOLD}%)."
echo "Will capture diagnostics once, then exit."

while true; do
  usage="$(cpu_usage_percent)"
  printf "Current CPU usage: %s%%\n" "$usage"

  if awk -v usage="$usage" -v threshold="$THRESHOLD" 'BEGIN { exit !(usage >= threshold) }'; then
    echo "CPU usage crossed threshold (${usage}% >= ${THRESHOLD}%). Capturing diagnostics..."
    bash "$ROOT_DIR/scripts/collect-diagnostics.sh"
    echo "Done."
    exit 0
  fi

  sleep "$INTERVAL"
done
