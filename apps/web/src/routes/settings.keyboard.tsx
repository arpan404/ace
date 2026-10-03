import { createFileRoute } from "@tanstack/react-router";
import { KeyboardSettingsScreen } from "@/features/settings/index.ts";

export const Route = createFileRoute("/settings/keyboard")({ component: KeyboardSettingsScreen });
