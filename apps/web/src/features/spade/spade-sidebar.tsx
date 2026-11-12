import { formatAge } from "@ace/ui-core";
import { spadeCappedLine, spadeStateLine } from "@ace/ui-core/spade-chat";
import { Link, useParams } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button.tsx";
import { ListSkeleton } from "@/components/ui/skeleton.tsx";
import { ViewSidebarError } from "@/components/ui/view-row.tsx";
import { ViewSidebar } from "@/features/shell/index.ts";
import { cn } from "@/lib/cn.ts";
import { useNow } from "@/lib/time.ts";
import { NewBotDialog } from "./spade-bot-dialog.tsx";
import { SpadeFace } from "./spade-face.tsx";
import { SpadeStateStrip } from "./spade-state.tsx";
import { useSpadeEnabled } from "./use-spade-enabled.ts";
import { useOneSpade, useSpadeRoster, type RosterBot } from "./use-spade-roster.ts";
import { useSpadeStatus } from "./use-spade-status.ts";
import { useTellZone } from "./use-spade-zone.ts";

/** The second line of a bot's row: what it does now, a cap it is at, else its latest message. */
export function rosterLine(bot: RosterBot): { text: string; tone?: "working" | "needs-you" } {
  if (bot.away) return { text: `Away · ${bot.machine.name} is offline` };
  if (bot.unavailable) return { text: `Unavailable · Spade isn't running on ${bot.machine.name}` };
  if (bot.state === "waiting" && bot.waitingFor === "question")
    return { text: "Asked you a question", tone: "needs-you" };
  if (bot.state === "waiting") return { text: bot.status ?? "Waiting for you", tone: "needs-you" };
  if (bot.state === "working") return { text: bot.status ?? "Working", tone: "working" };
  // At a cap it makes no model call until the cap ends (ADR 0135).
  if (bot.spending?.capped) return { text: spadeCappedLine(bot.spending.capped) };
  const last = bot.lastMessage;
  if (!last?.text) return { text: "No messages yet" };
  if (last.from === "agent") return { text: last.text };
  return { text: `${last.fromAgent ? last.fromAgent.name : "You"}: ${last.text}` };
}

/**
 * Spade's panel, a messenger's list (ADR 0127): Spade first, then every bot on every machine
 * this window reaches by latest activity. A row is the bot's face, its name and when it was last
 * active, then what it does now in its state's colour, or its latest message. A bot on an
 * offline machine reads as away, one whose Spade stopped as unavailable. "New bot" opens the
 * form. While Spade isn't running, its state in one sentence (with Turn on while it is off). The
 * panel sees every machine, so it keeps Spade, the main bot, on one (`useOneSpade`).
 */
export function SpadeSidebar() {
  const status = useSpadeStatus();
  const [enabled] = useSpadeEnabled();
  const line = spadeStateLine(status, enabled);
  const roster = useSpadeRoster(line.ready);
  useOneSpade(roster.hosting);
  useTellZone(useMemo(() => roster.hosts.map((host) => host.machine.client), [roster.hosts]));
  const open = useParams({ strict: false, select: (params) => params.agentId });
  const now = useNow();
  const [creating, setCreating] = useState(false);
  return (
    <ViewSidebar
      title="Spade"
      actions={
        roster.hosts.length > 0 && (
          <Button size="xs" variant="ghost" onClick={() => setCreating(true)}>
            New bot
          </Button>
        )
      }
      toolbar={line.ready ? undefined : <SpadeStateStrip line={line} />}
    >
      <nav aria-label="Bots">
        {/* The last list stays while Spade restarts or a read fails; it reads again on its own. */}
        {!roster.bots.length && !line.ready ? null : !roster.bots.length && roster.error ? (
          <ViewSidebarError onRetry={roster.refetch} />
        ) : !roster.bots.length && roster.loading ? (
          <ListSkeleton label="bots" shape="thread" />
        ) : (
          <ul className="flex flex-col gap-0.5">
            {roster.bots.map((bot) => (
              <li key={`${bot.machine.key}/${bot.id}`}>
                <Row bot={bot} current={open === bot.id} now={now} />
              </li>
            ))}
          </ul>
        )}
      </nav>
      {creating && <NewBotDialog hosts={roster.hosts} onClose={() => setCreating(false)} />}
    </ViewSidebar>
  );
}

function Row(props: { bot: RosterBot; current: boolean; now: number }) {
  const { bot } = props;
  const line = rosterLine(bot);
  return (
    <Link
      to="/spade/$agentId"
      params={{ agentId: bot.id }}
      search={bot.machine.primary ? {} : { on: bot.machine.key }}
      aria-current={props.current ? "page" : undefined}
      data-panel-row=""
      className="flex h-14 w-full min-w-0 items-center gap-2.5 rounded-md px-2.5 text-left transition-colors duration-(--motion-fast) focus-ring-inset hover:bg-hover aria-[current=page]:bg-active"
    >
      <SpadeFace
        avatar={bot.avatar}
        size={32}
        working={bot.state === "working" && !bot.away}
        ring="bg-(--sidebar-panel) shadow-[0_0_0_2px_var(--sidebar-panel)]"
        className={cn((bot.away || bot.unavailable) && "opacity-45")}
      />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="flex min-w-0 items-baseline gap-2">
          <span
            data-view-row-title=""
            className={cn(
              "min-w-0 flex-1 truncate text-md",
              bot.away || bot.unavailable ? "text-muted-foreground" : "text-foreground",
            )}
          >
            {bot.name}
          </span>
          <span className="shrink-0 text-xs text-subtle-foreground tabular-nums">
            {formatAge(bot.lastActivity, props.now)}
          </span>
        </span>
        <span
          data-tone={line.tone}
          className={cn(
            "truncate text-xs",
            line.tone ? "text-(--tone-text)" : "text-subtle-foreground",
          )}
        >
          {line.text}
        </span>
      </span>
    </Link>
  );
}
