import { formatAge } from "@ace/ui-core";
import { spadeStateLine } from "@ace/ui-core/spade-chat";
import { Link, useParams } from "@tanstack/react-router";
import { StatusLabel } from "@/components/status-label.tsx";
import { PanelRowBody, panelRow } from "@/components/ui/panel.tsx";
import { ListSkeleton } from "@/components/ui/skeleton.tsx";
import { ViewSidebarError } from "@/components/ui/view-row.tsx";
import { ViewSidebar } from "@/features/shell/index.ts";
import { useNow } from "@/lib/time.ts";
import { SpadeStateStrip } from "./spade-state.tsx";
import { useSpadeAgents } from "./use-spade-agents.ts";
import { useSpadeStatus } from "./use-spade-status.ts";
import { useSpadeEnabled } from "./use-spade-enabled.ts";

/**
 * Spade's panel: Spade's state in one sentence while it isn't running (with Turn on while it is
 * off), then Spade and the person's bots, Spade first. A row says Approve while the bot waits on
 * the person, Working while it works, otherwise how long ago it was last active. (Interim rows:
 * the messenger list replaces them, ADR 0127.)
 */
export function SpadeSidebar() {
  const status = useSpadeStatus();
  const [enabled] = useSpadeEnabled();
  const line = spadeStateLine(status, enabled);
  const list = useSpadeAgents(line.ready);
  const open = useParams({ strict: false, select: (params) => params.conversationId });
  const now = useNow();
  return (
    <ViewSidebar title="Spade" toolbar={line.ready ? undefined : <SpadeStateStrip line={line} />}>
      <nav aria-label="Bots">
        {/* The last list stays while Spade restarts or a read fails; it reads again on its own. */}
        {list.data === undefined && !line.ready ? null : list.data === undefined && list.isError ? (
          <ViewSidebarError onRetry={() => void list.refetch()} />
        ) : list.data === undefined ? (
          <ListSkeleton label="bots" shape="thread" />
        ) : !list.data.length ? (
          <p className="px-2.5 pt-2 text-ui text-subtle-foreground">No bots yet</p>
        ) : (
          <ul className="flex flex-col gap-px">
            {list.data.map((row) => (
              <li key={row.id}>
                <Link
                  to="/spade/$conversationId"
                  params={{ conversationId: row.conversation }}
                  aria-current={open === row.conversation ? "page" : undefined}
                  {...panelRow()}
                >
                  <PanelRowBody
                    title={row.name}
                    trailing={
                      row.state === "waiting" ? (
                        <StatusLabel tone="needs-you" label="Approve" />
                      ) : row.state === "working" ? (
                        <StatusLabel tone="working" label="Working" />
                      ) : (
                        <span className="shrink-0 text-xs text-subtle-foreground tabular-nums">
                          {formatAge(row.lastActivity, now)}
                        </span>
                      )
                    }
                  />
                </Link>
              </li>
            ))}
          </ul>
        )}
      </nav>
    </ViewSidebar>
  );
}
