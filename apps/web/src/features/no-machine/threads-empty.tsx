import { Link } from "@tanstack/react-router";
import { Button } from "@/components/ui/button.tsx";
import { EmptyState } from "@/components/ui/empty.tsx";
import { Screen } from "@/features/shell/index.ts";

/** Projects with no machine: threads run on one, so it says to add one. */
export function NoMachineThreads() {
  return (
    <Screen title="Projects" namedByPanel>
      <EmptyState
        title="Threads run on a machine. Add one to start."
        action={
          <Button variant="ghost" render={<Link to="/settings/remote" />}>
            Add a machine
          </Button>
        }
      />
    </Screen>
  );
}
