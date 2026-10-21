import { createFileRoute } from "@tanstack/react-router";
import { TriagePage } from "@/features/triage/index.ts";
import { ViewFrame } from "@/features/shell/index.ts";
export const Route = createFileRoute("/triage")({
  component: () => (
    <ViewFrame label="ace triage" place="threads">
      <TriagePage />
    </ViewFrame>
  ),
});
