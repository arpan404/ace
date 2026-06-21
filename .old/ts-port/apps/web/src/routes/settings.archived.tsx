import { createFileRoute } from "@tanstack/react-router";

import { ArchivedThreadsPanelRoute } from "../components/settings/LazySettingsPanels";

export const Route = createFileRoute("/settings/archived")({
  component: ArchivedThreadsPanelRoute,
});
