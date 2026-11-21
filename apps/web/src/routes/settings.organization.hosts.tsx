import { createFileRoute } from "@tanstack/react-router";
import { OrganizationSettingsScreen } from "@/features/settings/index.ts";

/** Settings › Organization › Hosts: the organization's machines, giving this one to it, and releasing one. */
export const Route = createFileRoute("/settings/organization/hosts")({
  component: () => <OrganizationSettingsScreen page="hosts" />,
});
