import { createFileRoute } from "@tanstack/react-router";
import { LaptopIcon } from "@phosphor-icons/react";
import { EmptyState } from "@/components/ui/empty.tsx";
import { SettingsBody } from "@/features/settings/settings-body.tsx";

/** TODO(settings slice): machines and paired devices, pairing with a code. */
export const Route = createFileRoute("/settings/remote")({
  component: () => (
    <SettingsBody
      page="Remote devices"
      lede="Machines running the ace daemon that this app can see. Threads from every machine merge into one list."
    >
      <EmptyState icon={LaptopIcon} title="Only this machine so far" className="h-auto" />
    </SettingsBody>
  ),
});
