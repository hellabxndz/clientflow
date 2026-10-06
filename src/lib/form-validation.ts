import type { FormField } from "./templates";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function validateField(f: FormField, raw: unknown, submitting: boolean): { value: unknown; error?: string } {
  if (f.type === "multiselect") {
    const values = (Array.isArray(raw) ? raw : []).map(String).filter((v) => (f.options ?? []).includes(v));
    if (submitting && f.required && values.length === 0) return { value: values, error: `Choose at least one option for "${f.label}".` };
    return { value: values };
  }
  const v = String(raw ?? "").trim().slice(0, 5000);
  if (!v) return submitting && f.required ? { value: v, error: `"${f.label}" is required.` } : { value: v };
  if (!submitting) return { value: v };
  switch (f.type) {
    case "email":
      return EMAIL_RE.test(v) ? { value: v } : { value: v, error: `"${f.label}" needs a valid email address.` };
    case "url":
      return /^https?:\/\/\S+\.\S+/.test(v) ? { value: v } : { value: v, error: `"${f.label}" needs a full web address starting with https://` };
    case "number":
      return Number.isFinite(Number(v)) ? { value: v } : { value: v, error: `"${f.label}" needs a number.` };
    case "date":
      return /^\d{4}-\d{2}-\d{2}$/.test(v) ? { value: v } : { value: v, error: `"${f.label}" needs a date.` };
    case "select":
      return (f.options ?? []).includes(v) ? { value: v } : { value: v, error: `Choose an option for "${f.label}".` };
    default:
      return { value: v };
  }
}
