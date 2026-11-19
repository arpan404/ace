import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { SpadeGroupScreen } from "@/features/spade/index.ts";

/**
 * A group's conversation (ADR 0132); `on` names the machine it lives on (its lead's) when that
 * isn't this one, and `profile` opens its profile beside it.
 */
export const Route = createFileRoute("/spade/groups/$groupId")({
  validateSearch: z.object({
    on: z.string().optional().catch(undefined),
    /** Its profile open beside the conversation. */
    profile: z.boolean().optional().catch(undefined),
  }),
  component: function SpadeGroupRoute() {
    const { groupId } = Route.useParams();
    const { on, profile } = Route.useSearch();
    return <SpadeGroupScreen groupId={groupId} machine={on} profile={profile} />;
  },
});
