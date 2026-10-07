import Link from "next/link";
import { requireManager } from "@/lib/session";
import { tenantCtx } from "@/lib/auth";
import { withTenant } from "@/lib/db";
import { PageHeader } from "@/components/ui";
import { DOC_CATEGORIES } from "@/lib/templates";
import { loadVocabulary } from "../data";
import { RuleBuilder } from "../builder";

export const metadata = { title: "New automation" };

export default async function NewAutomationPage() {
  const auth = await requireManager();
  const vocab = await withTenant(tenantCtx(auth), (tx) => loadVocabulary(tx));
  return (
    <div className="mx-auto max-w-3xl">
      <Link href="/app/automations" className="link text-sm">
        ← Automations
      </Link>
      <div className="mt-2">
        <PageHeader title="New automation" description="Choose what starts the rule, the conditions that must be true, and what happens next." />
      </div>
      <RuleBuilder vocab={vocab} categories={[...DOC_CATEGORIES]} />
    </div>
  );
}
