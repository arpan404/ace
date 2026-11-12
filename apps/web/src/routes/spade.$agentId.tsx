import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { SpadeAgentScreen } from "@/features/spade/index.ts";

/**
 * A bot's conversation; `on` names the machine it runs on when that isn't this one (not
 * `machine`, which shows the whole window against another machine).
 */
export const Route = createFileRoute("/spade/$agentId")({
  validateSearch: z.object({
    on: z.string().optional().catch(undefined),
    /** `routines`: the bot's routines and heartbeat instead of its conversation (ADR 0129). */
    view: z.enum(["routines"]).optional().catch(undefined),
  }),
  component: function SpadeAgentRoute() {
    const { agentId } = Route.useParams();
    const { on, view } = Route.useSearch();
    return <SpadeAgentScreen agentId={agentId} machine={on} view={view} />;
  },
});
