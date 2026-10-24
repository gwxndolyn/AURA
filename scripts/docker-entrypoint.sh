#!/bin/sh
# Container entrypoint: `web` (default) or `worker`. Uses exec so the Node process receives SIGTERM
# directly (graceful shutdown: running jobs are released back to the queue). Applies the schema first.
set -e
cd /app
node node_modules/prisma/build/index.js db push --skip-generate >/dev/null
case "${1:-web}" in
  web) exec node node_modules/next/dist/bin/next start -p "${PORT:-3000}" ;;
  worker) exec node node_modules/tsx/dist/cli.mjs scripts/worker.ts ;;
  *) exec "$@" ;;
esac
