import { PageHeader } from "@/components/ui";
import { SettingsTabs } from "./tabs";

export default function SettingsLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <PageHeader title="Settings" description="Your implementation workspace: company setup, branding, team, workflows, data and launch readiness." />
      <div className="mb-6">
        <SettingsTabs />
      </div>
      {children}
    </>
  );
}
