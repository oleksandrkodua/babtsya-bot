#!/bin/bash
# Self-check → commit → deploy, so every live version of the bot has a commit to go back to.
# Usage: ./deploy.sh "що змінилось"
set -e
cd "$(dirname "$0")"
npm test
git add -A
git diff --cached --quiet || git commit -q -m "${1:-deploy $(date '+%d.%m %H:%M')}"
npx wrangler deploy
git log --oneline -1
