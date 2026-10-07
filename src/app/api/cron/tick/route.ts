import { NextResponse, type NextRequest } from "next/server";
import { env } from "@/lib/env";
import { runScheduledTick } from "./run";

export const dynamic = "force-dynamic";

/**
 * Scheduled job: call every 5–15 minutes with `Authorization: Bearer $CRON_SECRET`.
 * Processes queued automation events, time-based rules (deadlines, inactivity, review waits) and reminders.
 * Every step is idempotent, so overlapping calls are safe.
 */
export async function POST(req: NextRequest) {
  if (!env.cronSecret || req.headers.get("authorization") !== `Bearer ${env.cronSecret}`)
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  return NextResponse.json(await runScheduledTick());
}
export const GET = POST;
