import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { ThreadView } from "@/features/thread/thread-view.tsx";

const ThreadSearch = z.object({
  /** Right-hand panel; part of the URL so it survives reloads and shared links. */
  panel: z.enum(["agents", "closed"]).default("agents").catch("agents"),
});

export const Route = createFileRoute("/w/$workspaceId/t/$threadId")({
  validateSearch: ThreadSearch,
  component: ThreadRoute,
});

function ThreadRoute() {
  const { threadId } = Route.useParams();
  const { panel } = Route.useSearch();
  const navigate = Route.useNavigate();
  return (
    <ThreadView
      key={threadId}
      threadId={threadId}
      panelOpen={panel === "agents"}
      onPanelChange={(open) =>
        void navigate({
          search: (previous) => ({ ...previous, panel: open ? "agents" : "closed" }),
          replace: true,
        })
      }
    />
  );
}
