import { createFileRoute } from "@tanstack/react-router";

import { BrowserSettingsPanelRoute } from "../components/settings/LazySettingsPanels";

export const Route = createFileRoute("/settings/browser")({
  component: BrowserSettingsPanelRoute,
});
