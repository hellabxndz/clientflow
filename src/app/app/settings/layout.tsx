import { PageHeader } from "@/components/ui";
import { SettingsTabs } from "./tabs";

export default function SettingsLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <PageHeader title="Settings" description="Workspace, team, reminders, integrations and security." />
      <div className="mb-6">
        <SettingsTabs />
      </div>
      {children}
    </>
  );
}
