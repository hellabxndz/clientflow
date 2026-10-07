import Link from "next/link";
import { ChevronRight, Clock } from "lucide-react";
import { AtRiskBadge, ReadinessPill, WaitingOnBadge } from "@/components/ui";
import { explainBlockers } from "@/lib/onboarding";
import type { LoadedOnboarding } from "@/lib/queries";
import { waitingOnLine } from "./waiting";

export function BlockerCard({ onboarding: o, names }: { onboarding: LoadedOnboarding; names: Map<string, string> }) {
  const line = waitingOnLine(o.state.blockers, o.state.waitingOn);
  const sentences = explainBlockers(o.state.blockers, names);
  const days = o.state.blockedDays;
  return (
    <Link
      href={`/app/clients/${o.client_id}`}
      className="group flex h-full min-w-0 flex-col rounded-xl border border-ink-200 bg-white p-5 shadow-sm transition hover:border-brand-200 hover:shadow-md"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-[15px] font-semibold text-ink-900">{o.client_name}</p>
          <p className="mt-0.5 truncate text-xs text-ink-500">
            {[o.client_type_name, o.owner_name ? `Owner: ${o.owner_name}` : "No owner"].filter(Boolean).join(" · ")}
          </p>
        </div>
        <ReadinessPill score={o.state.readiness.score} />
      </div>
      {line && <p className="mt-3 text-sm font-medium text-ink-800">{line}</p>}
      <p className="mt-1 line-clamp-2 text-sm text-ink-500">{sentences[0]}</p>
      {sentences.length > 1 && <p className="mt-1 text-xs text-ink-400">+{sentences.length - 1} more blocker{sentences.length === 2 ? "" : "s"}</p>}
      <div className="mt-auto flex flex-wrap items-center gap-2 pt-4">
        <span className={`inline-flex items-center gap-1 text-xs font-medium ${days >= 7 ? "text-rose-700" : days >= 3 ? "text-amber-700" : "text-ink-500"}`}>
          <Clock className="h-3.5 w-3.5" />
          {days === 0 ? "Blocked today" : `Blocked ${days} day${days === 1 ? "" : "s"}`}
        </span>
        <WaitingOnBadge waitingOn={o.state.waitingOn} />
        {o.state.atRisk && <AtRiskBadge />}
        <ChevronRight className="ml-auto h-4 w-4 text-ink-300 transition group-hover:text-brand-600" />
      </div>
    </Link>
  );
}
