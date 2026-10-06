import { CheckSquare, FileUp, FormInput, ListChecks, MessageCircleQuestion, PenLine } from "lucide-react";

export const KIND_LABEL = {
  form: "Form",
  file: "File request",
  checklist: "Checklist",
  question: "Question",
  task: "Internal task",
  signature: "E-signature (tracked)",
} as const;

export function KindIcon({ kind }: { kind: string }) {
  const Icon =
    kind === "form" ? FormInput : kind === "file" ? FileUp : kind === "checklist" ? ListChecks : kind === "question" ? MessageCircleQuestion : kind === "signature" ? PenLine : CheckSquare;
  return (
    <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-ink-100 text-ink-500">
      <Icon className="h-3.5 w-3.5" />
    </span>
  );
}
