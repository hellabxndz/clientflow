import Link from "next/link";
import { requireStaff } from "@/lib/session";
import { tenantCtx } from "@/lib/auth";
import { withTenant } from "@/lib/db";
import { loadOnboardings, staffNames } from "@/lib/queries";
import { Avatar, Badge, Card, EmptyState, Notice, PageHeader, Progress, StageBadge, Stat, Tabs } from "@/components/ui";
import { formatDate, localHour, relativeDays } from "@/lib/time";
import type { Blocker } from "@/lib/onboarding";

export const metadata = { title: "Overview" };

const REASON_LABEL: Record<Blocker["reason"], { label: string; tone: "danger" | "warning" | "info" | "neutral" }> = {
  overdue: { label: "Overdue", tone: "danger" },
  changes_requested: { label: "Changes requested", tone: "warning" },
  awaiting_review: { label: "Needs review", tone: "info" },
  dependency: { label: "Waiting on dependency", tone: "neutral" },
  not_started: { label: "Not started", tone: "neutral" },
};

export default async function OverviewPage({ searchParams }: { searchParams: Promise<{ denied?: string; mine?: string }> }) {
  const auth = await requireStaff();
  const sp = await searchParams;
  const mine = sp.mine === "1";
  const { onboardings, names } = await withTenant(tenantCtx(auth), async (tx) => ({
    onboardings: await loadOnboardings(tx, "o.status in ('active', 'paused')"),
    names: (await staffNames(tx)).map,
  }));

  const active = onboardings.filter((o) => o.status === "active");
  const overdueItems = active.flatMap((o) => o.state.overdue.map((i) => ({ ...i, onboarding: o })));
  const reviewOnboardings = active.filter((o) => o.state.awaitingReview.length > 0);
  const reviewCount = reviewOnboardings.reduce((n, o) => n + o.state.awaitingReview.length, 0);
  const ready = active.filter((o) => o.state.readyForCompletion);

  const blockers = active
    .flatMap((o) => o.state.blockers.map((b) => ({ ...b, onboarding: o })))
    .filter((b) => !mine || (b.ownerUserId ?? b.onboarding.owner_user_id) === auth.user.id)
    .sort((a, b) => {
      const order = { overdue: 0, changes_requested: 1, awaiting_review: 2, dependency: 3, not_started: 4 };
      return order[a.reason] - order[b.reason] || (a.dueAt?.getTime() ?? Infinity) - (b.dueAt?.getTime() ?? Infinity);
    });

  return (
    <>
      <PageHeader
        title={`Good ${greeting(auth.workspace.timezone)}, ${auth.user.name.split(" ")[0]}`}
        description="Here's where every client onboarding stands today."
        actions={
          <Link href="/app/clients/new" className="btn-primary">
            New client
          </Link>
        }
      />
      {sp.denied && (
        <Notice tone="warning" className="mb-6">
          That page is limited to workspace admins.
        </Notice>
      )}
      <div className="mb-6">
        <Tabs active="today" tabs={[{ key: "today", href: "/app", label: "Today" }, { key: "reports", href: "/app/reports", label: "Reports" }]} />
      </div>

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Stat label="Active onboardings" value={active.length} hint={`${onboardings.length - active.length} paused`} href="/app/clients" />
        <Stat label="Overdue requests" value={overdueItems.length} tone={overdueItems.length ? "warning" : undefined} hint={`across ${new Set(overdueItems.map((i) => i.onboarding.id)).size} clients`} href="#blockers" />
        <Stat label="Waiting for review" value={reviewOnboardings.length} hint={`${reviewCount} submitted item${reviewCount === 1 ? "" : "s"}`} href="/app/documents?status=pending" />
        <Stat label="Ready to start" value={ready.length} tone={ready.length ? "brand" : undefined} hint="all required items approved" href="#ready" />
      </div>

      <div className="mt-8 grid gap-6 xl:grid-cols-3">
        <div className="min-w-0 xl:col-span-2" id="blockers">
          <Card
            title="Blockers"
            padded={false}
            action={
              <div className="flex gap-1 text-sm">
                <Link href="/app" className={!mine ? "rounded-md bg-ink-100 px-2 py-1 font-medium" : "px-2 py-1 text-ink-500"}>All</Link>
                <Link href="/app?mine=1" className={mine ? "rounded-md bg-ink-100 px-2 py-1 font-medium" : "px-2 py-1 text-ink-500"}>Mine</Link>
              </div>
            }
          >
            {blockers.length === 0 ? (
              <div className="p-5">
                <EmptyState title="No blockers" description="Nothing is overdue, waiting on review or stuck on a dependency." />
              </div>
            ) : (
              <ul className="divide-y divide-ink-100">
                {blockers.slice(0, 15).map((b) => {
                  const owner = b.ownerUserId ?? b.onboarding.owner_user_id;
                  const reason = REASON_LABEL[b.reason];
                  return (
                    <li key={b.itemId + b.reason}>
                      <Link href={`/app/clients/${b.onboarding.client_id}/items/${b.itemId}`} className="flex flex-col gap-2 px-5 py-3.5 hover:bg-ink-50 sm:flex-row sm:items-center sm:gap-4">
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="font-medium text-ink-900">{b.title}</span>
                            <Badge tone={reason.tone}>{reason.label}</Badge>
                          </div>
                          <p className="mt-0.5 truncate text-sm text-ink-500">
                            {b.onboarding.client_name} · {b.detail}
                          </p>
                        </div>
                        <div className="flex items-center gap-3 text-sm text-ink-500 sm:w-56 sm:justify-end">
                          <span className="whitespace-nowrap">{b.waitingOn === "client" ? "Waiting on client" : "Waiting on team"}</span>
                          {owner ? (
                            <span className="flex items-center gap-1.5" title={`Owner: ${names.get(owner)}`}>
                              <Avatar name={names.get(owner) ?? "?"} />
                            </span>
                          ) : (
                            <Badge tone="warning">No owner</Badge>
                          )}
                        </div>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            )}
            {blockers.length > 15 && <p className="border-t border-ink-100 px-5 py-3 text-sm text-ink-500">And {blockers.length - 15} more. Open a client to see everything.</p>}
          </Card>
        </div>

        <div className="min-w-0 space-y-6">
          <Card title="Ready to start" padded={false}>
            <div id="ready" />
            {ready.length === 0 ? (
              <p className="px-5 py-4 text-sm text-ink-500">No onboardings have all required items approved yet.</p>
            ) : (
              <ul className="divide-y divide-ink-100">
                {ready.map((o) => (
                  <li key={o.id} className="flex items-center justify-between gap-3 px-5 py-3">
                    <div className="min-w-0">
                      <p className="truncate font-medium">{o.client_name}</p>
                      <p className="text-xs text-ink-500">Awaiting completion sign-off</p>
                    </div>
                    <Link href={`/app/clients/${o.client_id}`} className="btn-secondary px-3 py-1.5">Review</Link>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card title="Waiting for review" padded={false}>
            {reviewOnboardings.length === 0 ? (
              <p className="px-5 py-4 text-sm text-ink-500">Nothing submitted is waiting on the team.</p>
            ) : (
              <ul className="divide-y divide-ink-100">
                {reviewOnboardings.map((o) => (
                  <li key={o.id}>
                    <Link href={`/app/clients/${o.client_id}`} className="flex items-center justify-between gap-3 px-5 py-3 hover:bg-ink-50">
                      <div className="min-w-0">
                        <p className="truncate font-medium">{o.client_name}</p>
                        <p className="truncate text-xs text-ink-500">{o.state.awaitingReview.map((i) => i.title).join(", ")}</p>
                      </div>
                      <Badge tone="info">{o.state.awaitingReview.length}</Badge>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      </div>

      <div className="mt-8">
        <Card title="Active onboardings" padded={false} action={<Link href="/app/clients" className="link text-sm">All clients</Link>}>
          {onboardings.length === 0 ? (
            <div className="p-5">
              <EmptyState title="No onboardings yet" description="Add your first client to start collecting what you need." action={<Link href="/app/clients/new" className="btn-primary">New client</Link>} />
            </div>
          ) : (
            <ul className="divide-y divide-ink-100">
              {onboardings.map((o) => {
                const nextDue = o.items.filter((i) => i.required && i.status !== "approved" && i.status !== "submitted" && i.due_at).sort((a, b) => +new Date(a.due_at!) - +new Date(b.due_at!))[0];
                return (
                  <li key={o.id}>
                    <Link href={`/app/clients/${o.client_id}`} className="grid gap-2 px-5 py-3.5 hover:bg-ink-50 sm:grid-cols-[1fr_160px_180px_120px] sm:items-center sm:gap-4">
                      <div className="min-w-0">
                        <p className="truncate font-medium">{o.client_name}</p>
                        <p className="truncate text-xs text-ink-500">{o.owner_name ?? "No owner"} · started {formatDate(o.start_date)}</p>
                      </div>
                      <div><StageBadge stage={o.state.stage} /></div>
                      <div className="flex items-center gap-2">
                        <Progress value={o.state.progress.percent} />
                        <span className="w-10 text-right text-xs text-ink-500">{o.state.progress.percent}%</span>
                      </div>
                      <p className="text-xs text-ink-500 sm:text-right">{nextDue ? (new Date(nextDue.due_at!) < new Date() ? <span className="text-rose-700">Overdue since {formatDate(nextDue.due_at)}</span> : `Next due ${relativeDays(nextDue.due_at)}`) : "Nothing due"}</p>
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>
      </div>
    </>
  );
}

function greeting(tz: string) {
  const h = localHour(new Date(), tz);
  return h < 12 ? "morning" : h < 18 ? "afternoon" : "evening";
}
