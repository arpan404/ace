import { createFileRoute } from "@tanstack/react-router";
import { AutomationsEmptyScreen } from "@/features/automations/index.ts";

export const Route = createFileRoute("/automations/")({ component: AutomationsEmptyScreen });
