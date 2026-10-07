"use server";

import { revalidatePath } from "next/cache";
import { withTenant } from "@/lib/db";
import { tenantCtx } from "@/lib/auth";
import { actionAuth } from "@/lib/session";
import { audit } from "@/lib/audit";
import { fail, int, str } from "@/lib/action-helpers";
import { isValidTimeZone, WEEKDAY_LABEL } from "@/lib/time";
import type { ActionState } from "@/components/forms";

/** Company information: name, time zone, business days and hours, kickoff lead time, upload limit. Admins only. */
export async function updateCompanyAction(_: ActionState, fd: FormData): Promise<ActionState> {
  try {
    const auth = await actionAuth("admin");
    const ctx = tenantCtx(auth);
    const name = str(fd, "name");
    if (!name || name.length > 120) return { error: "Enter a company name (up to 120 characters)." };
    const tz = str(fd, "timezone");
    if (!isValidTimeZone(tz)) return { error: "Choose a valid time zone." };
    const days = [...new Set(fd.getAll("businessDays").map((d) => Number(d)))].filter((d) => Number.isInteger(d) && d >= 1 && d <= 7).sort();
    if (days.length === 0) return { error: "Choose at least one business day." };
    const start = int(fd, "businessStartHour");
    const end = int(fd, "businessEndHour");
    if (start == null || start < 0 || start > 23) return { error: "Business hours must start between 0 and 23." };
    if (end == null || end < 1 || end > 24 || end <= start) return { error: "Business hours must end after they start (1–24)." };
    const lead = int(fd, "kickoffLeadDays");
    if (lead == null || lead < 0 || lead > 30) return { error: "Kickoff lead time must be between 0 and 30 business days." };
    const maxMb = int(fd, "maxUploadMb");
    if (maxMb == null || maxMb < 1 || maxMb > 100) return { error: "Upload limit must be between 1 and 100 MB." };
    await withTenant(ctx, async (tx) => {
      await tx.q(
        `update workspaces set name = $2, timezone = $3, business_days = $4, business_start_hour = $5, business_end_hour = $6,
           kickoff_lead_days = $7, max_upload_mb = $8 where id = $1`,
        [auth.workspace.id, name, tz, days, start, end, lead, maxMb],
      );
      await audit(tx, ctx, "workspace.updated", null, null, `Updated company information (${days.map((d) => WEEKDAY_LABEL[d]).join(", ")} ${start}:00–${end}:00, ${tz})`, {
        timezone: tz,
        businessDays: days,
        businessHours: [start, end],
        kickoffLeadDays: lead,
        maxUploadMb: maxMb,
      });
    });
    revalidatePath("/", "layout");
    return { ok: "Saved." };
  } catch (e) {
    return fail(e);
  }
}
