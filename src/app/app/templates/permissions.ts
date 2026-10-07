import type { AuthContext } from "@/lib/auth";

/** Managers and admins can always edit templates; staff only when the workspace allows it. Clients never. */
export function canEditTemplates(auth: Pick<AuthContext, "role" | "workspace">) {
  if (auth.role === "admin" || auth.role === "manager") return true;
  return auth.role === "staff" && auth.workspace.template_edit_role === "staff";
}

export const TEMPLATE_EDIT_DENIED = "Only managers and admins can edit templates in this workspace.";
