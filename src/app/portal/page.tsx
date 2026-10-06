import Link from "next/link";
import clsx from "clsx";
import { ChevronRight, Lock } from "lucide-react";
import { requireClient } from "@/lib/session";
import { tenantCtx } from "@/lib/auth";
import { withTenant } from "@/lib/db";
import { isOverdue, nextClientActions, unmetDependencies, type ItemLike } from "@/lib/onboarding";
import { StatusBadge, Notice, Progress } from "@/components/ui";
import { ActionForm, SubmitButton } from "@/components/forms";
import { formatDate, formatDateTime, relativeDays } from "@/lib/time";
import { clientCommentAction } from "./actions";

export const metadata = { title: "Your onboarding" };

export default async function PortalHome() {
  const auth = await requireClient();
  const data = await withTenant(tenantCtx(auth), async (tx) => {
    const onboarding = await tx.one<{ id: string; name: string; status: string; completed_at: Date | null }>(
      "select id, name, status, completed_at from onboardings where status <> 'cancelled' order by created_at desc limit 1",
    );
    if (!onboarding) return null;
    const items = await tx.q<ItemLike & { description: string | null; position: number }>(
      "select * from onboarding_items where onboarding_id = $1 order by position",
      [onboarding.id],
    );
    const comments = await tx.q<{ id: string; body: string; created_at: Date; author: string | null; mine: boolean; item_title: string | null }>(
      `select c.id, c.body, c.created_at, u.name as author, c.author_user_id = $2 as mine, i.title as item_title
       from comments c left join users u on u.id = c.author_user_id left join onboarding_items i on i.id = c.item_id
       where c.onboarding_id = $1 order by c.created_at desc limit 20`,
      [onboarding.id, auth.user.id],
    );
    const client = await tx.one<{ timezone: string }>("select timezone from clients where id = $1", [auth.clientId]);
    return { onboarding, items, comments, tz: client?.timezone ?? auth.workspace.timezone };
  });
  const ws = auth.workspace;

  if (!data) {
    return (
      <div className="card p-8 text-center">
        <h1 className="text-xl font-semibold">Nothing to do yet</h1>
        <p className="mt-2 text-ink-600">{ws.name} hasn't started your onboarding checklist yet. We'll email you when it's ready.</p>
      </div>
    );
  }
  const { onboarding, items } = data;
  const byKey = new Map(items.map((i) => [i.item_key, i]));
  const done = items.filter((i) => i.status === "approved" || i.status === "submitted").length;
  const percent = items.length ? Math.round((done / items.length) * 100) : 0;
  const next = nextClientActions(items);
  const nextUp = next.find((i) => unmetDependencies(i, byKey).length === 0);
  const sections = new Map<string, typeof items>();
  for (const i of items) sections.set(i.section_title, [...(sections.get(i.section_title) ?? []), i]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">Hi {auth.user.name.split(" ")[0]} 👋</h1>
        <p className="mt-2 text-[15px] leading-relaxed text-ink-600">{ws.portal_welcome}</p>
      </div>

      {onboarding.status === "completed" ? (
        <Notice tone="success" title="You're all set">Everything is approved and we're ready to start. Thank you!</Notice>
      ) : onboarding.status === "paused" ? (
        <Notice tone="warning" title="Onboarding paused">{ws.name} has paused this onboarding for now. You can still view and update your items.</Notice>
      ) : null}

      <div className="card p-5">
        <div className="flex items-center justify-between text-sm">
          <span className="font-medium">{done} of {items.length} done</span>
          <span className="text-ink-500">{percent}%</span>
        </div>
        <Progress value={percent} className="mt-2" color={ws.brand_color} />
      </div>

      {nextUp && onboarding.status !== "completed" && (
        <Link href={`/portal/items/${nextUp.id}`} className="block rounded-xl p-5 text-white shadow-md transition hover:opacity-95" style={{ background: ws.brand_color }}>
          <p className="text-xs font-semibold uppercase tracking-wider text-white/80">{nextUp.status === "changes_requested" ? "Needs your attention" : "Do this next"}</p>
          <div className="mt-1 flex items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="text-lg font-semibold">{nextUp.title}</p>
              <p className="text-sm text-white/85">
                {nextUp.status === "changes_requested" ? "We left a note on what to change." : nextUp.due_at ? `Due ${formatDate(nextUp.due_at, data.tz)} (${relativeDays(nextUp.due_at)})` : "No due date"}
              </p>
            </div>
            <ChevronRight className="h-6 w-6 shrink-0" />
          </div>
        </Link>
      )}
      {!nextUp && onboarding.status === "active" && (
        <Notice tone="success" title="Nothing waiting on you">Everything you've sent is with the team for review. We'll let you know if anything else is needed.</Notice>
      )}

      {[...sections.entries()].map(([section, list]) => (
        <section key={section}>
          <h2 className="mb-2 px-1 text-sm font-semibold uppercase tracking-wide text-ink-500">{section}</h2>
          <ul className="card divide-y divide-ink-100 overflow-hidden">
            {list.map((item) => {
              const blocked = unmetDependencies(item, byKey);
              const overdue = isOverdue(item);
              return (
                <li key={item.id}>
                  <Link href={`/portal/items/${item.id}`} className="flex items-center gap-3 px-4 py-4 hover:bg-ink-50 active:bg-ink-100">
                    <div className="min-w-0 flex-1">
                      <p className="font-medium text-ink-900">
                        {item.title}
                        {!item.required && <span className="ml-1.5 text-xs font-normal text-ink-400">Optional</span>}
                      </p>
                      <p className={clsx("mt-0.5 text-xs", overdue ? "font-medium text-rose-700" : "text-ink-500")}>
                        {blocked.length > 0 ? (
                          <span className="inline-flex items-center gap-1 text-ink-500"><Lock className="h-3 w-3" /> Opens after {blocked.map((b) => b.title).join(", ")}</span>
                        ) : item.status === "approved" ? "Approved" : item.due_at ? `${overdue ? "Overdue · was due" : "Due"} ${formatDate(item.due_at, data.tz)}` : "No due date"}
                      </p>
                    </div>
                    <StatusBadge status={item.status} />
                    <ChevronRight className="h-4 w-4 shrink-0 text-ink-300" />
                  </Link>
                </li>
              );
            })}
          </ul>
        </section>
      ))}

      <section className="card">
        <div className="border-b border-ink-100 px-5 py-3.5">
          <h2 className="font-semibold">Messages with {ws.name}</h2>
        </div>
        <ActionForm action={clientCommentAction} resetOnSuccess className="space-y-2 border-b border-ink-100 p-4">
          <input type="hidden" name="onboardingId" value={onboarding.id} />
          <textarea name="body" className="input min-h-[80px]" placeholder="Ask a question or share an update" required />
          <SubmitButton pendingText="Sending…">Send message</SubmitButton>
        </ActionForm>
        {data.comments.length === 0 ? (
          <p className="p-5 text-sm text-ink-500">No messages yet.</p>
        ) : (
          <ul className="divide-y divide-ink-100">
            {data.comments.map((c) => (
              <li key={c.id} className="px-5 py-3">
                <div className="flex justify-between gap-2 text-xs">
                  <span className="font-medium">{c.mine ? "You" : c.author ?? ws.name}</span>
                  <span className="text-ink-400">{formatDateTime(c.created_at, data.tz)}</span>
                </div>
                <p className="mt-1 whitespace-pre-line text-sm text-ink-700">{c.body}</p>
                {c.item_title && <p className="mt-1 text-xs text-ink-400">On “{c.item_title}”</p>}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
