import { createFileRoute } from "@tanstack/react-router";
import { ThemeEditorPage } from "@/features/settings/theme-editor/theme-editor-page.tsx";

export const Route = createFileRoute("/settings/theme-editor")({
  component: ThemeEditorPage,
});
