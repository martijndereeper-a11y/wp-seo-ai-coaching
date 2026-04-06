#!/bin/bash
# WP SEO AI — Bi-weekly Digest Cron Script
# Runs every Monday at 07:30, but only executes on bi-weekly schedule
# Starting: Monday April 7, 2026 (week 1), then April 21, May 5, etc.

# Bi-weekly check: count weeks since epoch, starting week = April 7, 2026
# April 7, 2026 = week number 2936 from epoch
START_WEEK=2936
CURRENT_WEEK=$(( $(date +%s) / 604800 ))
WEEKS_SINCE_START=$(( CURRENT_WEEK - START_WEEK ))

if (( WEEKS_SINCE_START % 2 != 0 )); then
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
