#!/bin/sh
# Container entry point: apply migrations, seed the Northstar demo workspace if it is missing, start the app.
# DEMO_RESET_ON_BOOT=true wipes the database and reseeds on every start (a fresh demo per deploy).
# Never set it on a deployment that holds real client data.
set -e

if [ "$DEMO_RESET_ON_BOOT" = "true" ]; then
  echo "DEMO_RESET_ON_BOOT=true: resetting the database"
  npx tsx scripts/migrate.ts --reset
else
  npx tsx scripts/migrate.ts
fi

if [ "$SEED_DEMO" != "false" ]; then
  npx tsx scripts/seed.ts
fi

exec npx next start -p "${PORT:-3000}"
