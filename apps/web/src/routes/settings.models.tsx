import { createFileRoute } from "@tanstack/react-router";

import { ModelsSettingsPanelRoute } from "../components/settings/LazySettingsPanels";

export const Route = createFileRoute("/settings/models")({
  component: ModelsSettingsPanelRoute,
});
