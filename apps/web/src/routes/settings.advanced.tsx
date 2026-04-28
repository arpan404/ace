import { createFileRoute } from "@tanstack/react-router";

import { AdvancedSettingsPanelRoute } from "../components/settings/LazySettingsPanels";

export const Route = createFileRoute("/settings/advanced")({
  component: AdvancedSettingsPanelRoute,
});
