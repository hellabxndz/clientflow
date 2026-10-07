import { Badge } from "@/components/ui";

export const RUN_STATUS_TONE = { succeeded: "success", partial: "warning", failed: "danger", skipped: "neutral" } as const;
export const RUN_STATUS_LABEL: Record<string, string> = { succeeded: "Succeeded", partial: "Partly succeeded", failed: "Failed", skipped: "Skipped" };

export function RunStatusBadge({ status }: { status: string | null }) {
  if (!status) return <Badge>Never run</Badge>;
  return <Badge tone={RUN_STATUS_TONE[status as keyof typeof RUN_STATUS_TONE] ?? "neutral"}>{RUN_STATUS_LABEL[status] ?? status}</Badge>;
}

/** IF … AND … THEN … rendering of a rule. */
export function IfThen({ when, conditions, joiner, actions }: { when: string; conditions: string[]; joiner: string; actions: string[] }) {
  const Kw = ({ children }: { children: React.ReactNode }) => (
    <span className="mr-1.5 inline-block rounded bg-ink-900 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-white">{children}</span>
  );
  const Chip = ({ children, tone = "ink" }: { children: React.ReactNode; tone?: "ink" | "brand" }) => (
    <span className={tone === "brand" ? "rounded-md bg-brand-50 px-2 py-0.5 text-brand-800 ring-1 ring-inset ring-brand-200" : "rounded-md bg-white px-2 py-0.5 text-ink-800 ring-1 ring-inset ring-ink-200"}>
      {children}
    </span>
  );
  return (
    <div className="flex flex-wrap items-center gap-x-1.5 gap-y-2 text-sm">
      <Kw>When</Kw>
      <Chip>{when}</Chip>
      {conditions.map((c, i) => (
        <span key={i} className="inline-flex items-center">
          <Kw>{i === 0 ? "If" : joiner}</Kw>
          <Chip>{c}</Chip>
        </span>
      ))}
      <span className="inline-flex items-center">
        <Kw>Then</Kw>
      </span>
      {actions.map((a, i) => (
        <Chip key={i} tone="brand">
          {a}
        </Chip>
      ))}
    </div>
  );
}
