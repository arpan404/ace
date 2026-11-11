import { formatAge } from "@ace/ui-core";
import { spadeRowWorking, spadeStateLine } from "@ace/ui-core/spade-chat";
import { NotePencilIcon } from "@phosphor-icons/react";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { StatusLabel } from "@/components/status-label.tsx";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { PanelRowBody, panelRow } from "@/components/ui/panel.tsx";
import { ListSkeleton } from "@/components/ui/skeleton.tsx";
import { ViewSidebarError } from "@/components/ui/view-row.tsx";
import { ViewSidebar } from "@/features/shell/index.ts";
import { useNow } from "@/lib/time.ts";
import { SpadeStateStrip } from "./spade-state.tsx";
import { useSpadeConversations } from "./use-spade-conversations.ts";
import { useSpadeStatus } from "./use-spade-status.ts";
import { useSpadeEnabled } from "./use-spade-enabled.ts";

/**
 * Spade's panel: "Spade" and New conversation, Spade's state in one sentence while it isn't
 * running (with Turn on while it is off), then its conversations, newest first. A row says
 * Working while Spade answers in it or one of its background jobs is out; otherwise how long ago
 * it last changed.
 */
export function SpadeSidebar() {
  const navigate = useNavigate();
  const status = useSpadeStatus();
  const [enabled] = useSpadeEnabled();
  const line = spadeStateLine(status, enabled);
  const list = useSpadeConversations(line.ready);
  const open = useParams({ strict: false, select: (params) => params.conversationId });
  const now = useNow();
  return (
    <ViewSidebar
      title="Spade"
      actions={
        <IconButton
          icon={NotePencilIcon}
          label="New conversation"
          size="panel"
          onClick={() => void navigate({ to: "/spade" })}
        />
      }
      toolbar={line.ready ? undefined : <SpadeStateStrip line={line} />}
    >
      <nav aria-label="Conversations">
        {/* The last list stays while Spade restarts or a read fails; it reads again on its own. */}
        {list.data === undefined && !line.ready ? null : list.data === undefined && list.isError ? (
          <ViewSidebarError onRetry={() => void list.refetch()} />
        ) : list.data === undefined ? (
          <ListSkeleton label="conversations" shape="thread" />
        ) : !list.data.length ? (
          <p className="px-2.5 pt-2 text-ui text-subtle-foreground">No conversations yet</p>
        ) : (
          <ul className="flex flex-col gap-px">
            {list.data.map((row) => (
              <li key={row.id}>
                <Link
                  to="/spade/$conversationId"
                  params={{ conversationId: row.id }}
                  aria-current={open === row.id ? "page" : undefined}
                  {...panelRow()}
                >
                  <PanelRowBody
                    title={row.title || "New conversation"}
                    trailing={
                      spadeRowWorking(row) ? (
                        <StatusLabel tone="working" label="Working" />
                      ) : (
                        <span className="shrink-0 text-xs text-subtle-foreground tabular-nums">
                          {formatAge(row.updatedAt, now)}
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
