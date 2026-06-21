import { createFileRoute } from "@tanstack/react-router";

import { EditorSettingsPanelRoute } from "../components/settings/LazySettingsPanels";

export const Route = createFileRoute("/settings/editor")({
  component: EditorSettingsPanelRoute,
});
