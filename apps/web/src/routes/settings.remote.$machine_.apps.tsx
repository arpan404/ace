import { createFileRoute } from "@tanstack/react-router";
import { FleetMachineAppsScreen } from "@/features/settings/index.ts";

/** One machine's apps and webhooks: outside apps connected to it and the webhooks that reach it. */
export const Route = createFileRoute("/settings/remote/$machine_/apps")({
  component: function FleetMachineAppsPage() {
    const { machine } = Route.useParams();
    return <FleetMachineAppsScreen id={machine} />;
  },
});
