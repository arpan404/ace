import { createFileRoute } from "@tanstack/react-router";
import { NewAutomationScreen } from "@/features/automations/index.ts";

export const Route = createFileRoute("/automations/new")({ component: NewAutomationScreen });
