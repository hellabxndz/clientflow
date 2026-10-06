"use client";

import clsx from "clsx";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { CheckSquare, FileText, LayoutDashboard, LayoutTemplate, Settings, Users } from "lucide-react";

const NAV = [
  { href: "/app", label: "Overview", icon: LayoutDashboard, exact: true },
  { href: "/app/clients", label: "Clients", icon: Users },
  { href: "/app/templates", label: "Templates", icon: LayoutTemplate },
  { href: "/app/tasks", label: "Tasks", icon: CheckSquare },
  { href: "/app/documents", label: "Documents", icon: FileText },
  { href: "/app/settings", label: "Settings", icon: Settings },
];

function isActive(pathname: string, href: string, exact?: boolean) {
  if (exact) return pathname === href || pathname.startsWith("/app/reports");
  return pathname === href || pathname.startsWith(href + "/");
}

export function SideNav() {
  const pathname = usePathname();
  return (
    <nav className="space-y-0.5">
      {NAV.map(({ href, label, icon: Icon, exact }) => {
        const active = isActive(pathname, href, exact);
        return (
          <Link
            key={href}
            href={href}
            className={clsx(
              "flex items-center gap-3 rounded-lg px-3 py-2 text-[15px] font-medium transition",
              active ? "bg-brand-50 text-brand-800" : "text-ink-600 hover:bg-ink-100 hover:text-ink-900",
            )}
            aria-current={active ? "page" : undefined}
          >
            <Icon className={clsx("h-[18px] w-[18px]", active ? "text-brand-600" : "text-ink-400")} />
            {label}
          </Link>
        );
      })}
    </nav>
  );
}

export function MobileNav() {
  const pathname = usePathname();
  return (
    <nav className="flex gap-1 overflow-x-auto px-4 pb-2 lg:hidden">
      {NAV.map(({ href, label, exact }) => {
        const active = isActive(pathname, href, exact);
        return (
          <Link
            key={href}
            href={href}
            className={clsx(
              "whitespace-nowrap rounded-full px-3 py-1.5 text-sm font-medium",
              active ? "bg-brand-600 text-white" : "bg-ink-100 text-ink-600",
            )}
          >
            {label}
          </Link>
        );
      })}
    </nav>
  );
}
