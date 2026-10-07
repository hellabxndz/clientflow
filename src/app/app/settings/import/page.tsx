import Link from "next/link";
import { requireManager } from "@/lib/session";
import { tenantCtx } from "@/lib/auth";
import { withTenant } from "@/lib/db";
import { Badge, Card, EmptyState, Meta, Notice } from "@/components/ui";
import { ActionForm, SubmitButton } from "@/components/forms";
import { IMPORT_FIELDS, IMPORT_KINDS, IMPORT_LABEL, validateImport, type ImportKind, type ImportSummary, type RowResult } from "@/lib/import";
import { formatDateTime } from "@/lib/time";
import { discardImportAction, runImportAction, saveMappingAction, uploadImportAction } from "./actions";

export const metadata = { title: "Data import" };

interface ImportRow {
  id: string;
  kind: ImportKind;
  filename: string;
  status: "uploaded" | "completed" | "failed";
  header: string[];
  rows: string[][];
  mapping: Record<string, number>;
  summary: ImportSummary | null;
  created_at: Date;
  completed_at: Date | null;
  created_by_name: string | null;
  row_count: number;
}

const KIND_HELP: Record<ImportKind, string> = {
  clients: "Company records with contact, account manager, client type and contract value. Import these first.",
  contacts: "Extra people at existing clients (billing, marketing, approvers).",
  onboardings: "Active onboardings (created from a published template) or completed history used for before/after reports.",
  tasks: "Internal tasks added to a client's active onboarding.",
  requirements: "Client requirements (questions, files, checklists) added to a client's active onboarding.",
};

/** Tolerates older summary shapes (e.g. seeded history) so counts never render as "undefined". */
function normSummary(s: Partial<ImportSummary> & { skipped?: number; errors?: unknown } | null) {
  if (!s) return null;
  const errors = Array.isArray(s.errors) ? (s.errors as ImportSummary["errors"]) : [];
  return {
    created: s.created ?? 0,
    skippedDuplicates: s.skippedDuplicates ?? s.skipped ?? 0,
    failed: s.failed ?? (typeof s.errors === "number" ? s.errors : errors.length),
    errors,
  };
}

function rowStatus(r: RowResult) {
  if (r.errors.length) return { label: "Error", tone: "danger" as const };
  if (r.duplicate) return { label: r.duplicate === "existing" ? "Duplicate (exists)" : "Duplicate (in file)", tone: "warning" as const };
  return { label: "OK", tone: "success" as const };
}

export default async function ImportPage({ searchParams }: { searchParams: Promise<{ id?: string; show?: string }> }) {
  const auth = await requireManager();
  const sp = await searchParams;
  const id = sp.id && /^[0-9a-f-]{36}$/i.test(sp.id) ? sp.id : null;
  const show = sp.show === "all" || sp.show === "problems" ? sp.show : "problems";
  const data = await withTenant(tenantCtx(auth), async (tx) => {
    const history = await tx.q<Omit<ImportRow, "rows" | "header" | "mapping">>(
      `select i.id, i.kind, i.filename, i.status, i.summary, i.created_at, i.completed_at, u.name as created_by_name, jsonb_array_length(i.rows)::int as row_count
       from imports i left join users u on u.id = i.created_by order by i.created_at desc limit 25`,
    );
    if (!id) return { history, current: null, validation: null };
    const current = await tx.one<ImportRow>(
      `select i.*, u.name as created_by_name, jsonb_array_length(i.rows)::int as row_count from imports i left join users u on u.id = i.created_by where i.id = $1`,
      [id],
    );
    const validation = current && current.status === "uploaded" ? await validateImport(tx, current.kind, current.rows, current.mapping) : null;
    return { history, current, validation };
  });

  const steps = ["Choose type", "Upload CSV", "Map columns", "Validate", "Import"];
  const step = !data.current ? 1 : data.current.status === "uploaded" ? 3 : 5;

  return (
    <div className="space-y-6">
      <ol className="flex flex-wrap gap-2 text-xs">
        {steps.map((s, i) => (
          <li key={s} className={`rounded-full px-3 py-1 font-medium ring-1 ring-inset ${i + 1 <= step ? "bg-brand-50 text-brand-700 ring-brand-200" : "bg-white text-ink-500 ring-ink-200"}`}>
            {i + 1}. {s}
          </li>
        ))}
      </ol>

      {id && !data.current && <Notice tone="warning">That import wasn&apos;t found. It may have been discarded.</Notice>}

      {!data.current && (
        <div className="grid gap-6 lg:grid-cols-3">
          <Card title="Upload a CSV" className="lg:col-span-2">
            <ActionForm action={uploadImportAction} className="space-y-4">
              <fieldset className="space-y-2">
                <legend className="label">What are you importing?</legend>
                <div className="grid gap-2 sm:grid-cols-2">
                  {IMPORT_KINDS.map((k, i) => (
                    <label key={k} className="flex cursor-pointer items-start gap-3 rounded-lg border border-ink-200 p-3 has-[:checked]:border-brand-300 has-[:checked]:bg-brand-50/60">
                      <input type="radio" name="kind" value={k} defaultChecked={i === 0} className="mt-1 h-4 w-4" />
                      <span>
                        <span className="block text-sm font-medium">{IMPORT_LABEL[k]}</span>
                        <span className="block text-xs text-ink-500">{KIND_HELP[k]}</span>
                      </span>
                    </label>
                  ))}
                </div>
              </fieldset>
              <div>
                <label className="label" htmlFor="file">CSV file</label>
                <input id="file" name="file" type="file" accept=".csv,text/csv" required className="block w-full text-sm file:mr-3 file:rounded-lg file:border-0 file:bg-ink-100 file:px-3 file:py-2 file:text-sm file:font-medium" />
                <p className="mt-1 text-xs text-ink-500">Up to 2 MB and 2,000 rows. The first row must contain column names. Comma, semicolon and tab separators work.</p>
              </div>
              <SubmitButton pendingText="Reading file…">Upload and map columns</SubmitButton>
            </ActionForm>
          </Card>
          <Card title="Fields by type">
            <div className="space-y-4 text-sm">
              {IMPORT_KINDS.map((k) => (
                <div key={k}>
                  <p className="font-medium text-ink-800">{IMPORT_LABEL[k]}</p>
                  <p className="mt-0.5 text-xs text-ink-500">
                    {IMPORT_FIELDS[k].map((f) => `${f.label}${f.required ? " *" : ""}`).join(" · ")}
                  </p>
                </div>
              ))}
              <p className="text-xs text-ink-400">* required. Nothing is written until you confirm the import.</p>
            </div>
          </Card>
        </div>
      )}

      {data.current && data.current.status === "uploaded" && data.validation && (
        <MappingStep imp={data.current} validation={data.validation} show={show} />
      )}

      {data.current && data.current.status !== "uploaded" && (() => {
        const sum = normSummary(data.current.summary);
        return (
        <Card title={`Import summary · ${data.current.filename}`} action={<Link href="/app/settings/import" className="link text-sm">New import</Link>}>
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            <Meta label="Type">{IMPORT_LABEL[data.current.kind]}</Meta>
            <Meta label="Created">{sum?.created ?? 0}</Meta>
            <Meta label="Duplicates skipped">{sum?.skippedDuplicates ?? 0}</Meta>
            <Meta label="Failed">{sum?.failed ?? 0}</Meta>
          </div>
          <p className="mt-3 text-xs text-ink-500">
            Imported {formatDateTime(data.current.completed_at)} by {data.current.created_by_name ?? "a former team member"} from {data.current.row_count} rows.
          </p>
          {sum?.errors.length ? (
            <div className="mt-4 overflow-x-auto rounded-lg border border-rose-200">
              <table className="w-full text-sm">
                <thead className="bg-rose-50"><tr><th className="table-head">Row</th><th className="table-head">Problem</th></tr></thead>
                <tbody className="divide-y divide-rose-100">
                  {sum.errors.map((e) => (
                    <tr key={e.row}><td className="table-cell tabular-nums">{e.row}</td><td className="table-cell">{e.message}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : sum?.failed ? (
            <Notice tone="warning" className="mt-4">{sum.failed} row{sum.failed === 1 ? "" : "s"} failed; row details weren&apos;t recorded for this import.</Notice>
          ) : (
            <Notice tone="success" className="mt-4">No rows failed.</Notice>
          )}
          <div className="mt-4 flex flex-wrap gap-3 text-sm">
            {data.current.kind === "clients" || data.current.kind === "contacts" ? <Link className="link" href="/app/clients">Open clients</Link> : null}
            {data.current.kind === "onboardings" && <Link className="link" href="/app/reports">See reports</Link>}
            {data.current.kind === "tasks" && <Link className="link" href="/app/tasks">Open tasks</Link>}
          </div>
        </Card>
        );
      })()}

      <Card title="Import history" padded={false}>
        {data.history.length === 0 ? (
          <div className="p-5"><EmptyState title="No imports yet" /></div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px]">
              <thead className="border-b border-ink-100 bg-ink-50/60">
                <tr>
                  <th className="table-head">File</th>
                  <th className="table-head">Type</th>
                  <th className="table-head">Status</th>
                  <th className="table-head text-right">Rows</th>
                  <th className="table-head text-right">Created</th>
                  <th className="table-head text-right">Skipped / failed</th>
                  <th className="table-head">When</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-100">
                {data.history.map((h) => (
                  <tr key={h.id} className="hover:bg-ink-50">
                    <td className="table-cell"><Link href={`/app/settings/import?id=${h.id}`} className="link">{h.filename}</Link></td>
                    <td className="table-cell">{IMPORT_LABEL[h.kind]}</td>
                    <td className="table-cell">
                      <Badge tone={h.status === "completed" ? "success" : h.status === "failed" ? "danger" : "warning"}>
                        {h.status === "uploaded" ? "Not imported yet" : h.status === "completed" ? "Completed" : "Failed"}
                      </Badge>
                    </td>
                    <td className="table-cell text-right tabular-nums">{h.row_count}</td>
                    <td className="table-cell text-right tabular-nums">{normSummary(h.summary)?.created ?? "–"}</td>
                    <td className="table-cell text-right tabular-nums">{h.summary ? `${normSummary(h.summary)!.skippedDuplicates} / ${normSummary(h.summary)!.failed}` : "–"}</td>
                    <td className="table-cell text-xs text-ink-500">{formatDateTime(h.completed_at ?? h.created_at)} · {h.created_by_name ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

function MappingStep({ imp, validation, show }: { imp: ImportRow; validation: Awaited<ReturnType<typeof validateImport>>; show: "all" | "problems" }) {
  const fields = IMPORT_FIELDS[imp.kind];
  const { results, missingRequired } = validation;
  const ok = results.filter((r) => !r.errors.length && !r.duplicate).length;
  const dupes = results.filter((r) => !r.errors.length && r.duplicate).length;
  const errors = results.filter((r) => r.errors.length).length;
  const warnings = results.filter((r) => r.warnings.length).length;
  const visible = (show === "all" ? results : results.filter((r) => r.errors.length || r.duplicate || r.warnings.length)).slice(0, 200);
  const keyFields = fields.filter((f) => imp.mapping[f.key] !== undefined).slice(0, 3);
  return (
    <div className="space-y-6">
      <Card
        title={`Map columns · ${imp.filename}`}
        action={
          <ActionForm action={discardImportAction} showSuccess={false} confirm="Discard this upload? Nothing has been imported.">
            <input type="hidden" name="id" value={imp.id} />
            <SubmitButton className="btn-ghost px-2 py-1 text-xs">Discard</SubmitButton>
          </ActionForm>
        }
      >
        <p className="mb-4 text-sm text-ink-600">
          {IMPORT_LABEL[imp.kind]} · {imp.row_count} rows · {imp.header.length} columns. Columns were matched automatically by name; check each one.
        </p>
        <ActionForm action={saveMappingAction} className="space-y-4">
          <input type="hidden" name="id" value={imp.id} />
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {fields.map((f) => {
              const idx = imp.mapping[f.key];
              const sample = idx !== undefined ? imp.rows.find((r) => r[idx])?.[idx] : undefined;
              return (
                <div key={f.key}>
                  <label className="label" htmlFor={`map_${f.key}`}>
                    {f.label}
                    {f.required && <span className="text-rose-600"> *</span>}
                  </label>
                  <select id={`map_${f.key}`} name={`map_${f.key}`} className="input" defaultValue={idx !== undefined ? String(idx) : ""}>
                    <option value="">Don&apos;t import</option>
                    {imp.header.map((h, i) => <option key={i} value={i}>{h || `Column ${i + 1}`}</option>)}
                  </select>
                  <p className="mt-1 truncate text-xs text-ink-500">{sample ? `e.g. ${sample}` : f.help ?? (f.required ? "Required" : "Optional")}</p>
                </div>
              );
            })}
          </div>
          <SubmitButton className="btn-secondary" pendingText="Checking…">Save mapping and re-validate</SubmitButton>
        </ActionForm>
      </Card>

      <Card title="Validation preview" padded={false}>
        <div className="grid grid-cols-2 gap-4 border-b border-ink-100 p-5 sm:grid-cols-4">
          <Meta label="Ready to import"><span className="text-emerald-700">{ok}</span></Meta>
          <Meta label="Duplicates (skipped)"><span className="text-amber-700">{dupes}</span></Meta>
          <Meta label="Errors (skipped)"><span className="text-rose-700">{errors}</span></Meta>
          <Meta label="Rows with warnings">{warnings}</Meta>
        </div>
        {missingRequired.length > 0 && (
          <div className="p-5 pb-0"><Notice tone="danger">Map these required columns first: {missingRequired.join(", ")}.</Notice></div>
        )}
        <div className="flex flex-wrap items-center gap-3 px-5 pt-4 text-sm">
          <span className="text-ink-500">Show:</span>
          <Link href={`/app/settings/import?id=${imp.id}&show=problems`} className={show === "problems" ? "font-semibold text-ink-900" : "link"}>Rows needing attention</Link>
          <Link href={`/app/settings/import?id=${imp.id}&show=all`} className={show === "all" ? "font-semibold text-ink-900" : "link"}>All rows</Link>
        </div>
        {visible.length === 0 ? (
          <p className="px-5 py-4 text-sm text-ink-500">{show === "problems" ? "No problems found." : "No rows."}</p>
        ) : (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full min-w-[640px]">
              <thead className="border-y border-ink-100 bg-ink-50/60">
                <tr>
                  <th className="table-head">Row</th>
                  {keyFields.map((f) => <th key={f.key} className="table-head">{f.label}</th>)}
                  <th className="table-head">Status</th>
                  <th className="table-head">Messages</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-100">
                {visible.map((r) => {
                  const st = rowStatus(r);
                  return (
                    <tr key={r.row} className="align-top">
                      <td className="table-cell tabular-nums text-ink-500">{r.row}</td>
                      {keyFields.map((f) => <td key={f.key} className="table-cell max-w-[200px] truncate">{r.values[f.key] || <span className="text-ink-300">—</span>}</td>)}
                      <td className="table-cell"><Badge tone={st.tone}>{st.label}</Badge></td>
                      <td className="table-cell text-xs">
                        {r.errors.map((m) => <p key={m} className="text-rose-700">{m}</p>)}
                        {r.warnings.map((m) => <p key={m} className="text-amber-700">{m}</p>)}
                        {r.duplicate && !r.errors.length && (
                          <p className="text-ink-500">{r.duplicate === "existing" ? "Matches an existing record; will be skipped." : "Repeats an earlier row in this file; will be skipped."}</p>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {results.length > 200 && visible.length === 200 && <p className="px-5 py-2 text-xs text-ink-500">Showing the first 200 rows.</p>}
          </div>
        )}
        <div className="flex flex-col gap-3 border-t border-ink-100 p-5 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-sm text-ink-600">Duplicates and rows with errors are skipped. Each row is imported on its own, so one bad row can&apos;t break the rest.</p>
          <ActionForm action={runImportAction} confirm={`Import ${ok} row${ok === 1 ? "" : "s"} now?`}>
            <input type="hidden" name="id" value={imp.id} />
            <SubmitButton pendingText="Importing…" disabled={missingRequired.length > 0 || ok === 0}>
              Import {ok} row{ok === 1 ? "" : "s"}
            </SubmitButton>
          </ActionForm>
        </div>
      </Card>
    </div>
  );
}
