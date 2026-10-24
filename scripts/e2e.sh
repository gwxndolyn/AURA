#!/usr/bin/env bash
# Full e2e run: fresh database, provider test doubles (model + Stripe) at the
# HTTP boundary, a dev server wired to them, then Playwright. Docker is used
# for real execution when available. Usage: scripts/e2e.sh [playwright args]
set -euo pipefail
cd "$(dirname "$0")/.."
DIST=${AURA_DIST_DIR:-/tmp/aura-next-e2e}
TMP=${E2E_TMP:-/tmp/aura-e2e}
mkdir -p "$TMP"
lsof -ti:3000,4010,4011 | xargs kill 2>/dev/null || true
rm -f prisma/e2e.db && DATABASE_URL="file:./e2e.db" npx prisma db push --skip-generate >/dev/null
rm -rf "$TMP/git" "$TMP/work"
npx tsx test/doubles/serve.ts > "$TMP/doubles.log" 2>&1 &
DOUBLES=$!
export AURA_WORKER="${AURA_WORKER:-inline}" DATABASE_URL="file:./e2e.db" AURA_GIT_ROOT="$TMP/git" AURA_WORK_ROOT="$TMP/work" AURA_DIST_DIR="$DIST" AURA_CHECK_TIMEOUT_MS=90000 AURA_JOB_BACKOFF_MS=1000 AURA_REGISTER_LIMIT_PER_HOUR=20 \
  ANTHROPIC_API_KEY=test-e2e ANTHROPIC_BASE_URL=http://127.0.0.1:4010 \
  STRIPE_SECRET_KEY=sk_test_e2e STRIPE_WEBHOOK_SECRET=whsec_e2e STRIPE_PRICE_PRO=price_pro_e2e STRIPE_PRICE_TEAM=price_team_e2e STRIPE_API_BASE=http://127.0.0.1:4011
npx next dev -p 3000 > "$TMP/server.log" 2>&1 &
SERVER=$!
trap 'kill $SERVER $DOUBLES 2>/dev/null || true' EXIT
for i in $(seq 1 120); do curl -sf -o /dev/null http://localhost:3000/api/health && break; sleep 3; done
curl -sf -o /dev/null http://localhost:3000/ || { echo "server not healthy"; tail -50 "$TMP/server.log"; exit 1; }
E2E_EXTERNAL_SERVER=1 npx playwright test "$@"
