import { createFileRoute } from "@tanstack/react-router";
import { Placeholder } from "@/components/placeholder.tsx";

export const Route = createFileRoute("/conductor")({
  component: () => (
    <Placeholder
      title="Conductor"
      description="Lanes for orchestrated runs arrive with the conductor client work."
    />
  ),
});
