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
    /** With `files`, a file in it opened (a report a file chip opens). */
    file: z.string().optional().catch(undefined),
    /**
     * `routines`: the bot's routines and heartbeat instead of its conversation (ADR 0129);
     * `activity`: what it did (ADR 0135).
     */
    view: z.enum(["routines", "activity"]).optional().catch(undefined),
  }),
  component: function SpadeAgentRoute() {
    const { agentId } = Route.useParams();
    const { on, files, file, view } = Route.useSearch();
    return (
      <SpadeAgentScreen agentId={agentId} machine={on} files={files} file={file} view={view} />
    );
  },
});
