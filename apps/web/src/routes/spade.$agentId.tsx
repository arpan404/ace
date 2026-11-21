import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { SpadeAgentScreen } from "@/features/spade/index.ts";

/**
 * A bot's conversation; `on` names the machine it runs on when that isn't this one (not
 * `machine`, which shows the whole window against another machine). With `profile`, its profile
 * open beside it on that tab; `computer` what its Computer tab shows, `files` and `file` where
 * its file manager is (`.` for the top).
 */
export const Route = createFileRoute("/spade/$agentId")({
  validateSearch: z.object({
    on: z.string().optional().catch(undefined),
    profile: z
      .enum(["details", "permissions", "work", "library", "computer"])
      .optional()
      .catch(undefined),
    computer: z
      .enum(["browser", "screen", "terminal", "files", "services", "activity"])
      .optional()
      .catch(undefined),
    files: z.string().optional().catch(undefined),
    /** With `files`, a file in it opened (a report a file chip opens). */
    file: z.string().optional().catch(undefined),
    /** An approval or question to bring forward, by call id: what a notification opens. */
    request: z.string().optional().catch(undefined),
    /** One of its package's panels open beside it (ADR 0200 §5.2), by id. */
    panel: z
      .string()
      .regex(/^[a-z0-9][a-z0-9-]{0,39}$/)
      .optional()
      .catch(undefined),
  }),
  component: function SpadeAgentRoute() {
    const { agentId } = Route.useParams();
    const { on, profile, computer, files, file, request, panel } = Route.useSearch();
    return (
      <SpadeAgentScreen
        agentId={agentId}
        machine={on}
        profile={profile}
        computer={computer}
        files={files}
        file={file}
        request={request}
        panel={panel}
      />
    );
  },
});
