import { createFileRoute } from "@tanstack/react-router";
import { EditAutomationScreen } from "@/features/automations/index.ts";

export const Route = createFileRoute("/automations/$automationId/edit")({ component: Edit });

function Edit() {
  const { automationId } = Route.useParams();
  return <EditAutomationScreen id={automationId} />;
}
