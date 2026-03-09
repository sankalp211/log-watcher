#!/usr/bin/env bash
# generate.sh — Simulate a live-appending log file for local development.
#
# Usage:
#   ./logs/generate.sh                   # append 1 line/sec forever
#   ./logs/generate.sh --fast            # append 1 line every 200ms
#   ./logs/generate.sh --count 20        # append exactly 20 lines then stop
#   ./logs/generate.sh --file /tmp/x.log # write to a custom file
#
# In another terminal, run the server:
#   npm run dev
# Then open: http://localhost:3000/log

set -euo pipefail

# Defaults
TARGET_FILE="$(dirname "$0")/sample.log"
INTERVAL=1
COUNT=0  # 0 = unlimited

# Parse flags
while [[ $# -gt 0 ]]; do
  case "$1" in
    --fast)   INTERVAL=0.2; shift ;;
    --count)  COUNT="$2"; shift 2 ;;
    --file)   TARGET_FILE="$2"; shift 2 ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

LEVELS=("INFO" "INFO" "INFO" "INFO" "WARN" "ERROR")
MODULES=("http" "db" "cache" "worker" "scheduler" "auth" "system")
HTTP_METHODS=("GET" "POST" "PUT" "DELETE" "PATCH")
HTTP_PATHS=("/api/users" "/api/products" "/api/orders" "/api/cart" "/api/session" "/api/metrics" "/api/dashboard")
HTTP_CODES=(200 200 200 201 204 400 401 404 500)

random_element() {
  local arr=("$@")
  echo "${arr[RANDOM % ${#arr[@]}]}"
}

random_int() {
  echo $(( (RANDOM % ($2 - $1 + 1)) + $1 ))
}

generate_line() {
  local ts
  ts="$(date -u +"%Y-%m-%dT%H:%M:%S.%3NZ" 2>/dev/null || date -u +"%Y-%m-%dT%H:%M:%SZ")"
  local level
  level="$(random_element "${LEVELS[@]}")"
  local module
  module="$(random_element "${MODULES[@]}")"

  if [[ "$module" == "http" ]]; then
    local method path code duration uid
    method="$(random_element "${HTTP_METHODS[@]}")"
    path="$(random_element "${HTTP_PATHS[@]}")"
    code="$(random_element "${HTTP_CODES[@]}")"
    duration="$(random_int 5 900)ms"
    uid="user_$(random_int 1000 9999)"
    echo "${ts} ${level}  [${module}] ${method} ${path} ${code} ${duration} — uid=${uid}"
  elif [[ "$module" == "db" ]]; then
    local queries
    queries="$(random_int 1 50)"
    local duration
    duration="$(random_int 2 1500)ms"
    echo "${ts} ${level}  [${module}] Query executed — rows=${queries} duration=${duration}"
  elif [[ "$module" == "cache" ]]; then
    local hit="$(random_int 60 99)"
    echo "${ts} ${level}  [${module}] Cache stats — hit_rate=${hit}% keys=$(random_int 500 5000)"
  else
    echo "${ts} ${level}  [${module}] Periodic task completed — duration=$(random_int 10 500)ms"
  fi
}

i=0
echo "Appending to: $TARGET_FILE  (Ctrl-C to stop)"

while true; do
  generate_line >> "$TARGET_FILE"
  i=$(( i + 1 ))

  if [[ "$COUNT" -gt 0 && "$i" -ge "$COUNT" ]]; then
    echo "Done — appended $i lines."
    break
  fi

  sleep "$INTERVAL"
done
