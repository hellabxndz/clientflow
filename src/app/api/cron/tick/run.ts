import { processPendingEvents, runTimeTriggers } from "../../../../lib/automation/engine";
import { runReminders } from "../../../../lib/reminders";
import { pruneRateLimits } from "../../../../lib/rate-limit";

/** One scheduler tick: queued automation events, time-based rules, then reminders. Shared by /api/cron/tick and `npm run jobs:tick`. */
export async function runScheduledTick() {
  const started = Date.now();
  const events = await processPendingEvents();
  const time = await runTimeTriggers();
  // Time-based rule actions can emit new events (for example "mark At Risk"); process them in the same tick.
  const followUp = await processPendingEvents();
  const reminders = await runReminders();
  await pruneRateLimits().catch(() => {});
  return {
    ok: true,
    events: { processed: events.processed + followUp.processed, ruleRuns: events.runs + followUp.runs },
    timeTriggers: { ruleRuns: time.runs },
    reminders,
    durationMs: Date.now() - started,
  };
}
