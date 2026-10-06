"use client";

import { usePathname } from "next/navigation";
import { Tabs } from "@/components/ui";

const TABS = [
  { key: "/app/settings", href: "/app/settings", label: "General" },
  { key: "/app/settings/team", href: "/app/settings/team", label: "Team" },
  { key: "/app/settings/reminders", href: "/app/settings/reminders", label: "Reminders" },
  { key: "/app/settings/email", href: "/app/settings/email", label: "Email" },
  { key: "/app/settings/ai", href: "/app/settings/ai", label: "AI & data" },
  { key: "/app/settings/security", href: "/app/settings/security", label: "Security" },
  { key: "/app/settings/audit", href: "/app/settings/audit", label: "Audit log" },
];

export function SettingsTabs() {
  const pathname = usePathname();
  return <Tabs tabs={TABS} active={pathname} />;
}
