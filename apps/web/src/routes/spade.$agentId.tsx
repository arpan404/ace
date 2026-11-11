import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { SpadeAgentScreen } from "@/features/spade/index.ts";

/** A bot's conversation; `machine` names the machine it runs on when that isn't this one. */
export const Route = createFileRoute("/spade/$agentId")({
  validateSearch: z.object({ machine: z.string().optional().catch(undefined) }),
  component: function SpadeAgentRoute() {
    const { agentId } = Route.useParams();
    const { machine } = Route.useSearch();
    return <SpadeAgentScreen agentId={agentId} machine={machine} />;
  },
});
