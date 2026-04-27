import { createFileRoute } from "@tanstack/react-router";

import { ProvidersSettingsPanelRoute } from "../components/settings/LazySettingsPanels";

export const Route = createFileRoute("/settings/providers")({
  component: ProvidersSettingsPanelRoute,
});
