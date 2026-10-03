import { createFileRoute } from "@tanstack/react-router";
import { NewAutomationScreen } from "@/features/automations/automation-editor-screen.tsx";

export const Route = createFileRoute("/automations/new")({ component: NewAutomationScreen });
