import { createFileRoute } from "@tanstack/react-router";
import { OrganizationSettingsScreen } from "@/features/settings/index.ts";

/** Settings › Organization › Registry: the organization's private packages on the Marketplace. */
export const Route = createFileRoute("/settings/organization/registry")({
  component: () => <OrganizationSettingsScreen page="registry" />,
});
