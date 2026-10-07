#!/bin/sh
# Container entry point: apply migrations, seed the Northstar demo workspace if it is missing, start the app.
# DEMO_RESET_ON_BOOT=true wipes the database and reseeds on every start (a fresh demo per deploy).
# Never set it on a deployment that holds real client data.
set -e

# Without DATABASE_URL the app falls back to localhost and crashes with ECONNREFUSED; say what is wrong instead.
if [ -z "$DATABASE_URL" ]; then
  echo "DATABASE_URL is not set (or is empty). Point it at your Postgres database, e.g. on Railway"
  echo "add a variable reference to the Postgres service's DATABASE_URL, then redeploy."
  exit 1
fi

if [ "$DEMO_RESET_ON_BOOT" = "true" ]; then
  echo "DEMO_RESET_ON_BOOT=true: resetting the database"
  npx tsx scripts/migrate.ts --reset
else
  npx tsx scripts/migrate.ts
fi

if [ "$SEED_DEMO" != "false" ]; then
  npx tsx scripts/seed.ts
fi

exec npx next start -H 0.0.0.0 -p "${PORT:-3000}"
