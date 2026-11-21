import { createFileRoute } from "@tanstack/react-router";
import { OrganizationSettingsScreen } from "@/features/settings/index.ts";

/** Settings › Organization › Policy: the ceiling over what the organization's shared bots may do. */
export const Route = createFileRoute("/settings/organization/policy")({
  component: () => <OrganizationSettingsScreen page="policy" />,
});
