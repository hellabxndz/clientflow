import "dotenv/config";
import { pool } from "../src/lib/db";
import { runScheduledTick } from "../src/app/api/cron/tick/run";

// Run every 5–15 minutes (cron, systemd timer, or your host's scheduler). Processes queued automation events,
// time-based rules and reminders. Every step is idempotent, so overlapping runs are safe.
runScheduledTick()
  .then((summary) => console.log(JSON.stringify(summary)))
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
