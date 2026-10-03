import { createFileRoute } from "@tanstack/react-router";
import { ProviderSettings, RediscoverButton } from "@/features/settings/providers-page.tsx";
import { SettingsBody } from "@/features/settings/settings-body.tsx";

export const Route = createFileRoute("/settings/providers")({
  component: () => (
    <SettingsBody
      page="Providers & accounts"
      lede="ace uses the CLIs installed on this machine and their own logins. Manage quota and scheduling under Usage & accounts."
      actions={<RediscoverButton />}
    >
      <ProviderSettings />
    </SettingsBody>
  ),
});
