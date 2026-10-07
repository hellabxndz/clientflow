import Link from "next/link";
import { CheckCircle2, Circle, Rocket } from "lucide-react";
import { requireStaff } from "@/lib/session";
import { tenantCtx } from "@/lib/auth";
import { withTenant } from "@/lib/db";
import { launchChecklist } from "@/lib/launch";
import { Badge, Card, Notice, Progress } from "@/components/ui";
import { ActionForm, SubmitButton } from "@/components/forms";
import { formatDate, formatDateTime } from "@/lib/time";
import { setLaunchedAction, toggleLaunchItemAction } from "./actions";

export const metadata = { title: "Launch checklist" };

export default async function LaunchPage() {
  const auth = await requireStaff();
  const canEdit = auth.role === "admin" || auth.role === "manager";
  const list = await withTenant(tenantCtx(auth), (tx) => launchChecklist(tx, auth.workspace.id));
  const pct = Math.round((list.done / list.total) * 100);
  const launch = list.items.find((i) => i.mode === "launch")!;
  const steps = list.items.filter((i) => i.mode !== "launch");
  const remaining = steps.filter((i) => !i.done);
  return (
    <div className="grid gap-6 lg:grid-cols-3">
      <div className="min-w-0 space-y-6 lg:col-span-2">
        <Card>
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-wider text-ink-400">Implementation progress</p>
              <p className="mt-1 text-2xl font-semibold tracking-tight">{list.done} of {list.total} steps</p>
            </div>
            {list.launchedAt ? <Badge tone="success">Launched {formatDate(list.launchedAt)}</Badge> : <Badge tone="warning">Not launched</Badge>}
          </div>
          <Progress value={pct} className="mt-4" />
          <p className="mt-2 text-xs text-ink-500">Automatic steps are checked from your live configuration. Manual steps are ticked off by a manager or admin.</p>
        </Card>

        <Card padded={false}>
          <ul className="divide-y divide-ink-100">
            {steps.map((item) => (
              <li key={item.key} className="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-start">
                {item.done ? <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-emerald-600" aria-label="Done" /> : <Circle className="mt-0.5 h-5 w-5 shrink-0 text-ink-300" aria-label="Not done" />}
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-center gap-2 font-medium text-ink-900">
                    {item.label}
                    <Badge tone={item.mode === "auto" ? "neutral" : "info"}>{item.mode === "auto" ? "Automatic" : "Manual"}</Badge>
                  </p>
                  <p className="mt-0.5 text-sm text-ink-500">{item.description}</p>
                  {item.detail && <p className="mt-1 text-xs text-ink-600">{item.detail}</p>}
                  {item.mode === "manual" && item.done && item.doneAt && (
                    <p className="mt-1 text-xs text-ink-500">Checked off {formatDateTime(item.doneAt)}{item.doneBy ? ` by ${item.doneBy}` : ""}</p>
                  )}
                </div>
                <div className="flex shrink-0 flex-wrap items-center gap-2 sm:justify-end">
                  <Link href={item.href} className="btn-secondary px-3 py-1.5 text-xs">{item.linkLabel}</Link>
                  {item.mode === "manual" && canEdit && (
                    <ActionForm action={toggleLaunchItemAction} showSuccess={false}>
                      <input type="hidden" name="key" value={item.key} />
                      <input type="hidden" name="done" value={item.done ? "false" : "true"} />
                      <SubmitButton className={item.done ? "btn-ghost px-3 py-1.5 text-xs" : "btn-primary px-3 py-1.5 text-xs"}>{item.done ? "Reopen" : "Mark done"}</SubmitButton>
                    </ActionForm>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </Card>
      </div>

      <div className="min-w-0 space-y-6">
        <Card title={<span className="flex items-center gap-2"><Rocket className="h-4 w-4 text-brand-600" /> {launch.label}</span>}>
          <p className="text-sm text-ink-600">{launch.description}</p>
          {list.launchedAt ? (
            <>
              <p className="mt-3 text-sm font-medium text-emerald-700">Launched on {formatDate(list.launchedAt)}.</p>
              {canEdit && (
                <ActionForm action={setLaunchedAction} className="mt-3" confirm="Clear the launch date? Before/after reports will stop until it's set again.">
                  <input type="hidden" name="launch" value="false" />
                  <SubmitButton className="btn-ghost px-2 py-1 text-xs">Clear launch date</SubmitButton>
                </ActionForm>
              )}
            </>
          ) : canEdit ? (
            <>
              {remaining.length > 0 && (
                <Notice tone="warning" className="mt-3">
                  {remaining.length} step{remaining.length === 1 ? "" : "s"} still open: {remaining.map((r) => r.label).join(", ")}. You can still launch; these stay on the list.
                </Notice>
              )}
              <ActionForm action={setLaunchedAction} className="mt-3" confirm="Mark the workspace as launched today?">
                <input type="hidden" name="launch" value="true" />
                <SubmitButton pendingText="Launching…">Mark ready and launch</SubmitButton>
              </ActionForm>
            </>
          ) : (
            <p className="mt-3 text-sm text-ink-500">A manager or admin marks the launch.</p>
          )}
        </Card>
        <Card title="Before vs after">
          <p className="text-sm text-ink-600">
            The launch date splits your history: onboardings completed before it (for example, past onboardings you imported) are the &ldquo;before&rdquo; baseline in{" "}
            <Link href="/app/reports" className="link">Reports</Link>.
          </p>
          <Link href="/app/settings/import" className="link mt-2 inline-block text-sm">Import past onboardings</Link>
        </Card>
      </div>
    </div>
  );
}
