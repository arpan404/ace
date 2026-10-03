import { createFileRoute } from "@tanstack/react-router";
import { ChartBarIcon } from "@phosphor-icons/react";
import { EmptyState } from "@/components/ui/empty.tsx";
import { Screen } from "@/features/shell/screen.tsx";

/** TODO(accounts slice): accounts per provider, usage rings, scheduling policy. */
export const Route = createFileRoute("/more/accounts")({
  component: () => (
    <Screen title="Usage & accounts">
      <EmptyState
        icon={ChartBarIcon}
        title="No accounts found yet"
        description="ace drives the CLIs you already have installed and signed in to. Usage comes from each provider; ace never stores credentials."
      />
    </Screen>
  ),
});
