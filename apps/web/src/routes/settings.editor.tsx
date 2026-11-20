import { createFileRoute } from "@tanstack/react-router";
import { EditorSettingsScreen } from "@/features/settings/index.ts";

export const Route = createFileRoute("/settings/editor")({ component: EditorSettingsScreen });
