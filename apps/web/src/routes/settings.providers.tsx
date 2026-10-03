import { createFileRoute } from "@tanstack/react-router";
import { PlugIcon } from "@phosphor-icons/react";
import { EmptyState } from "@/components/ui/empty.tsx";
import { SettingsBody } from "@/features/settings/settings-body.tsx";

/** TODO(settings slice): installed provider CLIs and their sign-in state. */
export const Route = createFileRoute("/settings/providers")({
  component: () => (
    <SettingsBody
      page="Providers & accounts"
      lede="ace uses the CLIs installed on this machine and their own logins. Manage quota and scheduling under Usage & accounts."
    >
      <EmptyState icon={PlugIcon} title="Looking for provider CLIs" className="h-auto" />
    </SettingsBody>
  ),
});
