"use client";

import { usePathname } from "next/navigation";
import { Tabs } from "@/components/ui";

const TABS = [
  { key: "/app/settings", href: "/app/settings", label: "Company" },
  { key: "/app/settings/branding", href: "/app/settings/branding", label: "Branding" },
  { key: "/app/settings/team", href: "/app/settings/team", label: "Team" },
  { key: "/app/settings/client-types", href: "/app/settings/client-types", label: "Client Types" },
  { key: "/app/settings/email", href: "/app/settings/email", label: "Email" },
  { key: "/app/settings/reminders", href: "/app/settings/reminders", label: "Reminders" },
  { key: "/app/settings/ai", href: "/app/settings/ai", label: "AI" },
  { key: "/app/settings/security", href: "/app/settings/security", label: "Security" },
  { key: "/app/settings/import", href: "/app/settings/import", label: "Data Import" },
  { key: "/app/settings/audit", href: "/app/settings/audit", label: "Audit Log" },
  { key: "/app/settings/launch", href: "/app/settings/launch", label: "Launch Checklist" },
  { key: "/app/settings/pilot-readiness", href: "/app/settings/pilot-readiness", label: "Pilot Readiness" },
];

export function SettingsTabs() {
  const pathname = usePathname();
  const active = TABS.filter((t) => pathname === t.key || pathname.startsWith(t.key + "/")).sort((a, b) => b.key.length - a.key.length)[0]?.key ?? pathname;
  return <Tabs tabs={TABS} active={active} />;
}
