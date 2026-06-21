import { createFileRoute } from "@tanstack/react-router";

import { GeneralSettingsPanelRoute } from "../components/settings/LazySettingsPanels";

export const Route = createFileRoute("/settings/general")({
  component: GeneralSettingsPanelRoute,
});
