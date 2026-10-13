import { createFileRoute } from "@tanstack/react-router";
import { AccountsPage } from "@/features/accounts/index.ts";
import { ViewFrame } from "@/features/shell/index.ts";

/**
 * Usage: accounts per provider, quota rings, usage over time and the scheduling policy. Reached
 * from the profile menu and the palette; the sidebar keeps the thread list.
 */
export const Route = createFileRoute("/usage")({
  component: () => (
    <ViewFrame label="Usage" place="threads">
      <AccountsPage />
    </ViewFrame>
  ),
});
