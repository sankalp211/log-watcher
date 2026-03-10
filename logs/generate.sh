#!/usr/bin/env bash
# Appends one log line per second to sample.log.
# Format: [YYYY-MM-DD HH:MM:SS] <random 0-500>

LOG_FILE="$(dirname "$0")/sample.log"

echo "Appending to: $LOG_FILE  (Ctrl-C to stop)"

LEVELS=("ERROR" "INFO" "WARN")

while true; do
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] ${LEVELS[$((RANDOM % 3))]} $((RANDOM % 501))" >> "$LOG_FILE"
  sleep 0.25
done
