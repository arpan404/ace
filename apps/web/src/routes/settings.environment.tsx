import { createFileRoute } from "@tanstack/react-router";

import { EnvironmentSettingsPanelRoute } from "../components/settings/LazySettingsPanels";

export const Route = createFileRoute("/settings/environment")({
  component: EnvironmentSettingsPanelRoute,
});
