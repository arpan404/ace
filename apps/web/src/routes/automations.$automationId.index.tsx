import { createFileRoute } from "@tanstack/react-router";
import { AutomationScreen } from "@/features/automations/index.ts";

export const Route = createFileRoute("/automations/$automationId/")({ component: Automation });

function Automation() {
  const { automationId } = Route.useParams();
  return <AutomationScreen id={automationId} />;
}
