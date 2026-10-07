import clsx from "clsx";
import { Bot, Eye, Lock, Mail, Settings, ShieldCheck, User, UserCog } from "lucide-react";
import { Badge } from "@/components/ui";
import { formatDate, formatDateTime } from "@/lib/time";
import type { TimelineEntry, TimelineKind } from "@/lib/timeline";

/** Exact wording required whenever files were stored without a malware scan. */
export const SCAN_NOT_CONFIGURED = "File scanning integration not configured. Enable before handling sensitive production documents.";

export function DocReviewBadge({ status }: { status: string }) {
  if (status === "approved") return <Badge tone="success">Accepted</Badge>;
  if (status === "changes_requested") return <Badge tone="warning">Changes requested</Badge>;
  if (status === "rejected") return <Badge tone="danger">Rejected</Badge>;
  return <Badge tone="info">Pending review</Badge>;
}

/** Days until a YYYY-MM-DD date (negative when past). */
export function daysUntil(date: string | Date) {
  const d = typeof date === "string" ? new Date(date.slice(0, 10) + "T12:00:00Z") : date;
  return Math.round((d.getTime() - Date.now()) / 86400000);
}

export function ExpiryBadge({ expiresOn }: { expiresOn: string | null }) {
  if (!expiresOn) return null;
  const days = daysUntil(expiresOn);
  const label = formatDate(expiresOn.slice(0, 10) + "T12:00:00Z");
  if (days < 0) return <Badge tone="danger">Expired {label}</Badge>;
  if (days <= 30) return <Badge tone="warning">Expires {label}</Badge>;
  return <Badge>Expires {label}</Badge>;
}

const KIND_STYLE: Record<TimelineKind, { icon: typeof User; cls: string; label: string }> = {
  client: { icon: User, cls: "bg-sky-50 text-sky-700 ring-sky-200", label: "Client" },
  staff: { icon: UserCog, cls: "bg-brand-50 text-brand-700 ring-brand-200", label: "Team" },
  review: { icon: ShieldCheck, cls: "bg-emerald-50 text-emerald-700 ring-emerald-200", label: "Review" },
  automation: { icon: Bot, cls: "bg-amber-50 text-amber-800 ring-amber-200", label: "Automation" },
  email: { icon: Mail, cls: "bg-violet-50 text-violet-700 ring-violet-200", label: "Email" },
  system: { icon: Settings, cls: "bg-ink-100 text-ink-600 ring-ink-200", label: "System" },
};

export function TimelineList({ entries }: { entries: TimelineEntry[] }) {
  if (entries.length === 0) return <p className="px-5 py-6 text-sm text-ink-500">Nothing recorded yet.</p>;
  let lastDay = "";
  return (
    <ol className="px-5 py-4">
      {entries.map((e) => {
        const style = KIND_STYLE[e.kind];
        const Icon = style.icon;
        const day = formatDate(e.at);
        const showDay = day !== lastDay;
        lastDay = day;
        return (
          <li key={e.id}>
            {showDay && <p className="mb-2 mt-4 text-[11px] font-semibold uppercase tracking-wider text-ink-400 first:mt-0">{day}</p>}
            <div className="relative flex gap-3 pb-4">
              <span className={clsx("flex h-7 w-7 shrink-0 items-center justify-center rounded-full ring-1 ring-inset", style.cls)} title={style.label}>
                <Icon className="h-3.5 w-3.5" />
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-sm text-ink-800">{e.title}</p>
                {e.detail && <p className="mt-0.5 text-xs text-ink-500">{e.detail}</p>}
                <p className="mt-0.5 text-xs text-ink-400">
                  {style.label}
                  {e.actor && ` · ${e.actor}`} · {formatDateTime(e.at)}
                </p>
              </div>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

export interface CommentRow {
  id: string;
  body: string;
  visibility: string;
  created_at: Date;
  author: string | null;
  author_role: string | null;
  source?: string | null;
  item_title?: string | null;
}

/** Client-visible messages and internal notes, styled so they are never confused. */
export function CommentList({ comments, empty = "No messages yet." }: { comments: CommentRow[]; empty?: string }) {
  if (comments.length === 0) return <p className="px-5 py-4 text-sm text-ink-500">{empty}</p>;
  return (
    <ul className="divide-y divide-ink-100">
      {comments.map((c) => {
        const internal = c.visibility === "internal";
        return (
          <li key={c.id} className={clsx("border-l-2 px-5 py-3", internal ? "border-amber-300 bg-amber-50/60" : "border-sky-300 bg-white")}>
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
              <span className="font-medium text-ink-800">
                {c.author ?? (c.source === "automation" ? "Automation" : "Former member")}
                {c.author_role === "client" && <span className="ml-1 font-normal text-ink-400">(client)</span>}
              </span>
              <span className="text-ink-400">{formatDateTime(c.created_at)}</span>
            </div>
            <p className="mt-1 whitespace-pre-line text-sm text-ink-700">{c.body}</p>
            <p className={clsx("mt-1.5 inline-flex items-center gap-1 text-[11px] font-medium", internal ? "text-amber-800" : "text-sky-700")}>
              {internal ? <Lock className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
              {internal ? "Internal note · team only" : "Visible to client"}
              {c.item_title && <span className="font-normal text-ink-500"> · {c.item_title}</span>}
            </p>
          </li>
        );
      })}
    </ul>
  );
}
