import { createFileRoute } from "@tanstack/react-router";
import { ThemeEditorPage } from "@/features/settings/index.ts";

export const Route = createFileRoute("/settings/theme-editor")({
  component: ThemeEditorPage,
});
