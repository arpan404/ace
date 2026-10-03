import { createFileRoute } from "@tanstack/react-router";
import { EditAutomationScreen } from "@/features/automations/automation-editor-screen.tsx";

export const Route = createFileRoute("/automations/$automationId/edit")({ component: Edit });

function Edit() {
  const { automationId } = Route.useParams();
  return <EditAutomationScreen id={automationId} />;
}
