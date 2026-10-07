import { createFileRoute } from "@tanstack/react-router";
import { SetupScreen } from "@/features/setup/index.ts";

/** First-run provider setup, also opened from Settings → Providers. */
export const Route = createFileRoute("/setup")({
  component: () => (
    <div className="relative flex min-w-0 flex-1 flex-col bg-reading">
      <SetupScreen />
    </div>
  ),
});
