import { createFileRoute } from "@tanstack/react-router";
import { OrganizationSettingsScreen } from "@/features/settings/index.ts";

/** Settings › Organization › Members: who belongs to the window's organization, invitations and roles. */
export const Route = createFileRoute("/settings/organization/")({
  component: () => <OrganizationSettingsScreen page="members" />,
});
