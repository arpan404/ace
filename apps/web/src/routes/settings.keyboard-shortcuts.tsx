import { createFileRoute } from "@tanstack/react-router";

import { KeyboardShortcutsSettingsPanelRoute } from "../components/settings/LazySettingsPanels";

export const Route = createFileRoute("/settings/keyboard-shortcuts")({
  component: KeyboardShortcutsSettingsPanelRoute,
});
