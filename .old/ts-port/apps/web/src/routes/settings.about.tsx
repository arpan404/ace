import { createFileRoute } from "@tanstack/react-router";

import { AboutSettingsPanelRoute } from "../components/settings/LazySettingsPanels";

export const Route = createFileRoute("/settings/about")({
  component: AboutSettingsPanelRoute,
});
