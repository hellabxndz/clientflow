import { NextResponse, type NextRequest } from "next/server";
import { runReminders } from "@/lib/reminders";
import { env } from "@/lib/env";

/** Call hourly from a scheduler: `Authorization: Bearer $CRON_SECRET`. */
export async function POST(req: NextRequest) {
  if (!env.cronSecret || req.headers.get("authorization") !== `Bearer ${env.cronSecret}`)
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const summary = await runReminders();
  return NextResponse.json(summary);
}
export const GET = POST;
