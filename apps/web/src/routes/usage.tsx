import { createFileRoute } from "@tanstack/react-router";
import { UsagePage } from "@/features/usage/index.ts";
import { ViewFrame } from "@/features/shell/index.ts";

/**
 * Usage: Cost, Tokens and Limits per environment and provider. Reached
 * from the profile menu and the palette; the sidebar keeps the thread list.
 */
export const Route = createFileRoute("/usage")({
  component: () => (
    <ViewFrame label="Usage" place="threads">
      <UsagePage />
    </ViewFrame>
  ),
});
