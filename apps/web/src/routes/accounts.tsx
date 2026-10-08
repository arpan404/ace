import { createFileRoute } from "@tanstack/react-router";
import { AccountsPage } from "@/features/accounts/index.ts";
import { ViewFrame } from "@/features/shell/index.ts";

/**
 * Usage and accounts: accounts per provider, quota rings, usage over time and the scheduling
 * policy. Reached from the profile menu only; the sidebar keeps the thread list.
 */
export const Route = createFileRoute("/accounts")({
  component: () => (
    <ViewFrame label="Usage & accounts" place="threads">
      <AccountsPage />
    </ViewFrame>
  ),
});
