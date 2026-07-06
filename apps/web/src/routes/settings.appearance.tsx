import { createFileRoute } from "@tanstack/react-router";

import { AppearanceSettingsPanelRoute } from "../components/settings/LazySettingsPanels";

export const Route = createFileRoute("/settings/appearance")({
  component: AppearanceSettingsPanelRoute,
});
