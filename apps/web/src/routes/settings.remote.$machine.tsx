import { createFileRoute } from "@tanstack/react-router";
import { FleetMachineScreen } from "@/features/settings/index.ts";

/** One machine in the fleet: its identity, reach, links and devices. */
export const Route = createFileRoute("/settings/remote/$machine")({
  component: function FleetMachinePage() {
    const { machine } = Route.useParams();
    return <FleetMachineScreen id={machine} />;
  },
});
