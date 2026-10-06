import "dotenv/config";
import { pool } from "../src/lib/db";
import { runRetention } from "../src/lib/retention";

// Run daily. Purges stored files for completed or cancelled onboardings older than each workspace's retention setting.
runRetention()
  .then((summary) => console.log(JSON.stringify(summary)))
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
