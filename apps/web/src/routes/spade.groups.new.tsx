import { createFileRoute } from "@tanstack/react-router";
import { SpadeNewGroupScreen } from "@/features/spade/index.ts";

/** New group, drafted in place (ADR 0132, docs/design/spade.md §5). */
export const Route = createFileRoute("/spade/groups/new")({
  component: SpadeNewGroupScreen,
});
