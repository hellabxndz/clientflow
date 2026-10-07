import type { Role } from "./auth";

/**
 * What each role may do. Server actions check these and Postgres row-level security enforces
 * the same boundaries underneath (see db/migrations).
 *
 * - admin: everything, including team, security, integrations, branding and retention
 * - manager: operations setup (templates, automations, reminders, client types, imports), approvals
 * - staff: day-to-day onboarding work: clients, reviews, tasks, comments, uploads
 * - client: their own company's portal only
 */
export const PERMISSIONS = {
  manageTeam: ["admin"],
  manageSecurity: ["admin"],
  manageIntegrations: ["admin"],
  manageBranding: ["admin", "manager"],
  manageAutomations: ["admin", "manager"],
  manageReminders: ["admin", "manager"],
  manageClientTypes: ["admin", "manager"],
  importData: ["admin", "manager"],
  viewAudit: ["admin"],
  upgradeOnboardings: ["admin", "manager"],
  reassignReviews: ["admin", "manager", "staff"],
} as const satisfies Record<string, readonly Role[]>;

export type Permission = keyof typeof PERMISSIONS;

export function can(role: Role, permission: Permission) {
  return (PERMISSIONS[permission] as readonly Role[]).includes(role);
}

export function isStaffRole(role: Role) {
  return role === "admin" || role === "manager" || role === "staff";
}

export const ROLE_LABEL: Record<Role, string> = { admin: "Admin", manager: "Manager", staff: "Staff", client: "Client" };
