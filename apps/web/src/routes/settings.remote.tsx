import { createFileRoute } from "@tanstack/react-router";
import { RemoteDevices } from "@/features/settings/remote-page.tsx";
import { SettingsBody } from "@/features/settings/settings-body.tsx";

export const Route = createFileRoute("/settings/remote")({
  component: () => (
    <SettingsBody
      page="Remote devices"
      lede="Machines running the ace daemon that this app can see. Threads from every machine merge into one list."
    >
      <RemoteDevices />
    </SettingsBody>
  ),
});
