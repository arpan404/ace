import { createFileRoute } from "@tanstack/react-router";

import { EditorSettingsPanel } from "../components/settings/SettingsPanels";

export const Route = createFileRoute("/settings/editor")({
  component: EditorSettingsPanel,
});
