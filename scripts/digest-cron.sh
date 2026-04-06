#!/bin/bash
# WP SEO AI — Bi-weekly Digest Cron Script
# Runs every Monday at 07:30, but only executes on bi-weekly schedule
# Starting: Monday April 20, 2026, then May 4, May 18, etc.

# Bi-weekly check: count weeks since epoch, starting week = April 20, 2026
# April 20, 2026 = week number 2937 from epoch
START_WEEK=2937
CURRENT_WEEK=$(( $(date +%s) / 604800 ))
WEEKS_SINCE_START=$(( CURRENT_WEEK - START_WEEK ))

if (( WEEKS_SINCE_START < 0 || WEEKS_SINCE_START % 2 != 0 )); then
  echo "$(date): Skipping — not a bi-weekly Monday"
  exit 0
fi

echo "$(date): Running bi-weekly digest..."

PROJECT_DIR="/Users/martijndereeper/Documents/VS Code/Document Hub"
LOG_FILE="$PROJECT_DIR/work/enablement/digests/cron.log"

cd "$PROJECT_DIR"

# Load nvm/node
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"

npm run digest:scheduled >> "$LOG_FILE" 2>&1

echo "$(date): Done (exit code: $?)" >> "$LOG_FILE"
