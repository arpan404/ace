import { createFileRoute } from "@tanstack/react-router";
import { SpadeSettingsScreen } from "@/features/spade/index.ts";

export const Route = createFileRoute("/settings/spade")({ component: SpadeSettingsScreen });
