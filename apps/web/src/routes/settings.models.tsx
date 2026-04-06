import { createFileRoute } from "@tanstack/react-router";

import { ModelsSettingsPanel } from "../components/settings/SettingsPanels";

export const Route = createFileRoute("/settings/models")({
  component: ModelsSettingsPanel,
});
