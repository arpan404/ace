import { createFileRoute } from "@tanstack/react-router";

import { ChatSettingsPanelRoute } from "../components/settings/LazySettingsPanels";

export const Route = createFileRoute("/settings/chat")({
  component: ChatSettingsPanelRoute,
});
