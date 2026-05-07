#!/bin/bash
set -e

AGENT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$AGENT_DIR"

echo "-> Pulling latest..."
git pull --ff-only origin main

echo "-> Installing dependencies..."
npm ci

echo "-> Building and verifying dist runtime..."
npm run ci

echo "-> Restarting with PM2..."
if pm2 describe social-agent > /dev/null 2>&1; then
  pm2 delete social-agent
fi

pm2 start dist/src/agent.js --name social-agent --restart-delay=5000
pm2 save

echo "OK Done."
pm2 status social-agent
