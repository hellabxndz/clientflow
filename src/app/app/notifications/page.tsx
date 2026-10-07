import Link from "next/link";
import clsx from "clsx";
import { AlertTriangle, Bell, CalendarCheck, CheckCheck, Info, Workflow } from "lucide-react";
import { requireStaff } from "@/lib/session";
import { tenantCtx } from "@/lib/auth";
import { withTenant } from "@/lib/db";
import { EmptyState, PageHeader, Tabs } from "@/components/ui";
import { formatDateTime, relativeDays } from "@/lib/time";
import { markAllNotificationsReadAction, markNotificationReadAction, openNotificationAction } from "./actions";

export const metadata = { title: "Notifications" };

interface NotificationRow {
  id: string;
  kind: string;
  title: string;
  body: string | null;
  link: string | null;
  created_at: Date;
  read_at: Date | null;
}

const KIND: Record<string, { icon: typeof Bell; label: string; className: string }> = {
  escalation: { icon: AlertTriangle, label: "Escalation", className: "bg-rose-50 text-rose-600 ring-rose-200" },
  handoff: { icon: CalendarCheck, label: "Handoff", className: "bg-brand-50 text-brand-600 ring-brand-200" },
  automation: { icon: Workflow, label: "Automation", className: "bg-sky-50 text-sky-600 ring-sky-200" },
  info: { icon: Info, label: "Update", className: "bg-ink-100 text-ink-500 ring-ink-200" },
};

export default async function NotificationsPage({ searchParams }: { searchParams: Promise<{ filter?: string }> }) {
  const auth = await requireStaff();
  const unreadOnly = (await searchParams).filter === "unread";
  const { rows, unread } = await withTenant(tenantCtx(auth), async (tx) => ({
    rows: await tx.q<NotificationRow>(
      `select id, kind, title, body, link, created_at, read_at from notifications
       where user_id = $1 and ($2::boolean = false or read_at is null)
       order by (read_at is null) desc, created_at desc limit 200`,
      [auth.user.id, unreadOnly],
    ),
    unread: Number((await tx.one<{ n: number }>("select count(*)::int as n from notifications where user_id = $1 and read_at is null", [auth.user.id]))?.n ?? 0),
  }));

  return (
    <>
      <PageHeader
        title="Notifications"
        description="Alerts from automation rules, escalations and handoffs that need your attention."
        actions={
          unread > 0 ? (
            <form action={markAllNotificationsReadAction}>
              <button className="btn-secondary">
                <CheckCheck className="h-4 w-4" /> Mark all read
              </button>
            </form>
          ) : undefined
        }
      />
      <div className="mb-6">
        <Tabs
          active={unreadOnly ? "unread" : "all"}
          tabs={[
            { key: "all", href: "/app/notifications", label: "All" },
            { key: "unread", href: "/app/notifications?filter=unread", label: `Unread${unread ? ` (${unread})` : ""}` },
          ]}
        />
      </div>

      {rows.length === 0 ? (
        <EmptyState
          title={unreadOnly ? "You're all caught up" : "No notifications yet"}
          description={unreadOnly ? "Every notification has been read." : "When automation rules or escalations need you, they will appear here."}
          action={unreadOnly ? <Link href="/app/notifications" className="btn-secondary">Show all</Link> : undefined}
        />
      ) : (
        <ul className="card divide-y divide-ink-100 overflow-hidden">
          {rows.map((n) => {
            const kind = KIND[n.kind] ?? KIND.info;
            const Icon = kind.icon;
            const isUnread = !n.read_at;
            return (
              <li key={n.id} className={clsx("flex gap-3 px-4 py-4 sm:gap-4 sm:px-5", isUnread ? "bg-brand-50/40" : "bg-white")}>
                <span className={clsx("mt-0.5 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full ring-1 ring-inset", kind.className)}>
                  <Icon className="h-4 w-4" />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-start gap-2">
                    {isUnread && <span className="mt-2 h-2 w-2 shrink-0 rounded-full bg-brand-600" aria-label="Unread" />}
                    {n.link ? (
                      <form action={openNotificationAction} className="min-w-0">
                        <input type="hidden" name="id" value={n.id} />
                        <button className={clsx("text-left text-sm hover:text-brand-700 hover:underline", isUnread ? "font-semibold text-ink-900" : "font-medium text-ink-700")}>
                          {n.title}
                        </button>
                      </form>
                    ) : (
                      <p className={clsx("min-w-0 text-sm", isUnread ? "font-semibold text-ink-900" : "font-medium text-ink-700")}>{n.title}</p>
                    )}
                  </div>
                  {n.body && <p className="mt-1 break-words text-sm text-ink-500">{n.body}</p>}
                  <p className="mt-1 text-xs text-ink-400" title={formatDateTime(n.created_at, auth.workspace.timezone)}>
                    {kind.label} · {relativeDays(n.created_at)}
                  </p>
                </div>
                {isUnread && (
                  <form action={markNotificationReadAction} className="shrink-0">
                    <input type="hidden" name="id" value={n.id} />
                    <button className="btn-ghost px-2 py-1 text-xs" title="Mark as read">
                      Mark read
                    </button>
                  </form>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}
