import { requireStaff } from "@/lib/session";
import { SideNav, MobileNav } from "@/components/staff-nav";
import { Logo } from "@/components/logo";
import { Avatar } from "@/components/ui";
import { logoutAction, switchWorkspaceAction } from "../auth-actions";
import { Bell, LogOut, UserRound } from "lucide-react";
import Link from "next/link";
import { withTenant } from "@/lib/db";
import { tenantCtx } from "@/lib/auth";
import { ROLE_LABEL } from "@/lib/permissions";

export default async function StaffLayout({ children }: { children: React.ReactNode }) {
  const auth = await requireStaff();
  const otherWorkspaces = auth.workspaces.filter((w) => w.id !== auth.workspace.id);
  const unread = await withTenant(tenantCtx(auth), async (tx) =>
    Number((await tx.one<{ n: number }>("select count(*)::int as n from notifications where user_id = $1 and read_at is null", [auth.user.id]))?.n ?? 0),
  );
  return (
    <div className="min-h-screen lg:flex">
      <aside className="hidden w-64 shrink-0 flex-col border-r border-ink-200 bg-white lg:flex lg:fixed lg:inset-y-0">
        <div className="px-5 pb-4 pt-5">
          <Logo />
        </div>
        <div className="px-3">
          <WorkspaceSwitcher current={auth.workspace.name} others={otherWorkspaces} />
        </div>
        <div className="mt-4 flex-1 px-3">
          <SideNav />
        </div>
        <div className="border-t border-ink-100 p-3">
          <div className="flex items-center gap-3 rounded-lg px-2 py-2">
            <Link href="/account" className="flex min-w-0 flex-1 items-center gap-3 rounded-md hover:opacity-80" title="Your account and two-step sign-in">
              <Avatar name={auth.user.name} />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{auth.user.name}</p>
                <p className="truncate text-xs text-ink-500">{ROLE_LABEL[auth.role]}</p>
              </div>
            </Link>
            <NotificationBell unread={unread} />
            <form action={logoutAction}>
              <button className="btn-ghost p-2" title="Sign out" aria-label="Sign out">
                <LogOut className="h-4 w-4" />
              </button>
            </form>
          </div>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col lg:pl-64">
        <header className="sticky top-0 z-20 border-b border-ink-200 bg-white/90 backdrop-blur lg:hidden">
          <div className="flex items-center justify-between px-4 py-3">
            <Logo compact />
            <div className="flex min-w-0 items-center gap-2">
              <WorkspaceSwitcher current={auth.workspace.name} others={otherWorkspaces} compact />
              <NotificationBell unread={unread} />
              <Link href="/account" className="btn-ghost p-2" aria-label="Your account">
                <UserRound className="h-4 w-4" />
              </Link>
              <form action={logoutAction}>
                <button className="btn-ghost p-2" aria-label="Sign out">
                  <LogOut className="h-4 w-4" />
                </button>
              </form>
            </div>
          </div>
          <MobileNav />
        </header>
        {auth.workspace.is_demo && (
          <div className="border-b border-brand-200 bg-brand-50 px-4 py-2 text-center text-[13px] text-brand-900 sm:px-8">
            <span className="font-semibold">Demo workspace.</span> All clients and people are fictional, and emails are recorded in the outbox but never sent.
          </div>
        )}
        <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-6 sm:px-8 sm:py-8">{children}</main>
      </div>
    </div>
  );
}

function WorkspaceSwitcher({ current, others, compact = false }: { current: string; others: { id: string; name: string }[]; compact?: boolean }) {
  if (others.length === 0)
    return compact ? (
      <span className="max-w-[160px] truncate text-sm font-medium text-ink-700">{current}</span>
    ) : (
      <div className="rounded-lg border border-ink-200 px-3 py-2 text-sm font-medium text-ink-800">{current}</div>
    );
  return (
    <details className="group relative">
      <summary className={`flex cursor-pointer list-none items-center justify-between gap-2 rounded-lg border border-ink-200 px-3 py-2 text-sm font-medium text-ink-800 hover:bg-ink-50 ${compact ? "max-w-[180px]" : ""}`}>
        <span className="truncate">{current}</span>
        <span className="text-ink-400">▾</span>
      </summary>
      <div className="absolute right-0 z-30 mt-1 w-64 rounded-lg border border-ink-200 bg-white p-1 shadow-lg lg:left-0">
        <p className="px-3 py-1.5 text-xs font-medium uppercase tracking-wide text-ink-400">Switch workspace</p>
        {others.map((w) => (
          <form key={w.id} action={switchWorkspaceAction}>
            <input type="hidden" name="workspaceId" value={w.id} />
            <button className="w-full rounded-md px-3 py-2 text-left text-sm hover:bg-ink-50">{w.name}</button>
          </form>
        ))}
      </div>
    </details>
  );
}

function NotificationBell({ unread }: { unread: number }) {
  return (
    <Link href="/app/notifications" className="btn-ghost relative p-2" aria-label={unread ? `${unread} unread notifications` : "Notifications"} title="Notifications">
      <Bell className="h-4 w-4" />
      {unread > 0 && (
        <span className="absolute -right-0.5 -top-0.5 inline-flex min-w-[18px] items-center justify-center rounded-full bg-brand-600 px-1 text-[10px] font-semibold leading-[18px] text-white">
          {unread > 99 ? "99+" : unread}
        </span>
      )}
    </Link>
  );
}
