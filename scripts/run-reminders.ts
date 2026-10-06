import "dotenv/config";
import { pool } from "../src/lib/db";
import { runReminders } from "../src/lib/reminders";

// Run hourly (cron, systemd timer, or your host's scheduler). Duplicates are prevented, so overlapping runs are safe.
runReminders()
  .then((summary) => console.log(JSON.stringify(summary)))
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
