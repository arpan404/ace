import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { SpadeGroupScreen } from "@/features/spade/index.ts";

/**
 * A group's conversation (ADR 0132); `on` names the machine it lives on (its lead's) when that
 * isn't this one.
 */
export const Route = createFileRoute("/spade/groups/$groupId")({
  validateSearch: z.object({
    on: z.string().optional().catch(undefined),
  }),
  component: function SpadeGroupRoute() {
    const { groupId } = Route.useParams();
    const { on } = Route.useSearch();
    return <SpadeGroupScreen groupId={groupId} machine={on} />;
  },
});
