import { createFileRoute } from "@tanstack/react-router";
import { OrganizationSettingsScreen } from "@/features/settings/index.ts";

/** Settings › Organization › Sign-in: the organization's domain, SSO and directory, in the WorkOS Admin Portal. */
export const Route = createFileRoute("/settings/organization/sign-in")({
  component: () => <OrganizationSettingsScreen page="sign-in" />,
});
