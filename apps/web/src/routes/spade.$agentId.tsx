import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { SpadeAgentScreen } from "@/features/spade/index.ts";

/**
 * A bot's conversation; `on` names the machine it runs on when that isn't this one (not
 * `machine`, which shows the whole window against another machine). With `files`, its files
 * instead: the folder shown (`.` for the top).
 */
export const Route = createFileRoute("/spade/$agentId")({
  validateSearch: z.object({
    on: z.string().optional().catch(undefined),
    files: z.string().optional().catch(undefined),
  }),
  component: function SpadeAgentRoute() {
    const { agentId } = Route.useParams();
    const { on, files } = Route.useSearch();
    return <SpadeAgentScreen agentId={agentId} machine={on} files={files} />;
  },
});
