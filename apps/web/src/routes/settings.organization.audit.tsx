import { createFileRoute } from "@tanstack/react-router";
import { OrganizationSettingsScreen } from "@/features/organization/index.ts";

/** Settings › Organization › Audit log: what the organization's hosts and bots did, to read, export and check. */
export const Route = createFileRoute("/settings/organization/audit")({
  component: () => <OrganizationSettingsScreen page="audit" />,
});
