import Link from "next/link";
import { notFound } from "next/navigation";
import { requireManager } from "@/lib/session";
import { tenantCtx } from "@/lib/auth";
import { withTenant } from "@/lib/db";
import { PageHeader } from "@/components/ui";
import { ActionForm, SubmitButton } from "@/components/forms";
import { DOC_CATEGORIES } from "@/lib/templates";
import { loadRules, loadVocabulary } from "../../data";
import { rowToInput } from "../../describe";
import { RuleBuilder } from "../../builder";
import { deleteAutomationRuleAction } from "../../actions";

export const metadata = { title: "Edit automation" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function EditAutomationPage({ params }: { params: Promise<{ id: string }> }) {
  const auth = await requireManager();
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  const { rule, vocab } = await withTenant(tenantCtx(auth), async (tx) => ({ rule: (await loadRules(tx, "r.id = $1", [id]))[0], vocab: await loadVocabulary(tx) }));
  if (!rule) notFound();
  return (
    <div className="mx-auto max-w-3xl">
      <Link href={`/app/automations/${id}`} className="link text-sm">
        ← {rule.name}
      </Link>
      <div className="mt-2">
        <PageHeader title="Edit automation" description="Changes apply to future runs. Past runs stay in the activity log." />
      </div>
      <RuleBuilder vocab={vocab} categories={[...DOC_CATEGORIES]} initial={rowToInput(rule)} ruleId={rule.id} />
      <section className="card mt-8 border-rose-200 p-5">
        <h2 className="text-[15px] font-semibold text-ink-900">Delete automation</h2>
        <p className="mt-1 text-sm text-ink-600">Deleting also removes its run history. To pause it instead, turn it off.</p>
        <ActionForm action={deleteAutomationRuleAction} className="mt-3" confirm={`Delete "${rule.name}" and its run history?`}>
          <input type="hidden" name="ruleId" value={rule.id} />
          <SubmitButton className="btn-danger" pendingText="Deleting…">
            Delete automation
          </SubmitButton>
        </ActionForm>
      </section>
    </div>
  );
}
