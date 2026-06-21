import { createFileRoute } from "@tanstack/react-router";

import { DevicesSettingsPanelRoute } from "../components/settings/LazySettingsPanels";

export const Route = createFileRoute("/settings/devices")({
  component: DevicesSettingsPanelRoute,
});
