import { useSidebarThread } from "@ace/client-react";
import { ThreadId } from "@ace/protocol";
import { faceForId } from "@ace/ui-core/bot-face";
import {
  spadeMoney,
  spadeWhen,
  spadeWorkersSpend,
  type SpadeAvatar,
  type SpadeDecision,
  type SpadeWorkerNode,
  type SpadeWorkerRow,
} from "@ace/ui-core/spade-chat";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { ProviderIcon } from "@/components/ui/provider-icons.tsx";
import { useToast } from "@/components/ui/toast.tsx";
import { cn } from "@/lib/cn.ts";
import { useNow } from "@/lib/time.ts";
import { SpadeFace } from "./spade-face.tsx";
import { useSpadeClient } from "./spade-machine.tsx";
import { ProfileSection, rowPill } from "./spade-profile-parts.tsx";
import { personZone } from "./spade-routines-api.ts";
import { stopConversation } from "./spade-work-api.ts";
import { workKey } from "./use-spade-work.ts";
import type { RosterBot } from "./use-spade-roster.ts";

/*
 * The bot's workers (ADR 0161) and the choices it made for the person (ADR 0165). A worker row
 * is its face or its provider's mark, its name, what it's doing in words and its plain spend;
 * hover trades the spend for Stop, which stops it and everything under it with no confirm
 * (writing to it starts it again). The row opens the worker: a bot's chat, an ace agent's thread.
 */

/** A row's end: its quiet fact, traded on hover or focus for its action, in the same place. */
const swap = "grid shrink-0 items-center justify-items-end [&>*]:[grid-area:1/1]";
/** The quiet fact, gone while the action shows. */
const revealedAway = "group-hover/row:invisible group-focus-within/row:invisible";
/** The action: there on hover or focus, and reachable by keyboard always. */
const revealed =
  "text-foreground opacity-0 focus-ring transition-opacity duration-(--motion-fast) group-hover/row:opacity-100 group-focus-within/row:opacity-100 focus-visible:opacity-100 hover:bg-hover";

const tones = {
  "needs-you": "text-status-needs-you",
  failed: "text-status-failed",
  working: "text-muted-foreground",
  rest: "text-muted-foreground",
} as const;

/** An ace agent's mark: its provider's, from the thread ace lists. */
function AceMark(props: { thread: string }) {
  const thread = useSidebarThread(props.thread);
  if (!thread) return <span aria-hidden className="size-7 shrink-0 rounded-full bg-hover" />;
  return (
    <span className="grid size-7 shrink-0 place-items-center text-foreground">
      <ProviderIcon provider={thread.provider} size={20} decorative />
    </span>
  );
}

function WorkerRow(props: {
  row: SpadeWorkerRow;
  avatar: SpadeAvatar;
  onOpen(): void;
  onStop(): Promise<void>;
}) {
  const { row } = props;
  const { node } = row;
  const [stopping, setStopping] = useState(false);
  return (
    <div
      className="group/row relative flex min-h-(--setting-row-height) items-center gap-3 py-2"
      style={{ paddingLeft: `calc(${row.depth} * var(--spacing) * 6)` }}
    >
      {node.kind === "ace" ? (
        <AceMark thread={node.id} />
      ) : (
        <SpadeFace avatar={props.avatar} size={28} />
      )}
      <button
        type="button"
        onClick={props.onOpen}
        aria-label={`Open ${node.name}`}
        className="flex min-w-0 flex-1 flex-col text-left focus-ring-inset after:absolute after:inset-0 after:content-['']"
      >
        <span className="truncate text-ui leading-5 font-medium text-foreground">{node.name}</span>
        <span className={cn("truncate text-xs leading-4", tones[row.tone])}>
          {stopping ? "Stopping" : row.line}
        </span>
      </button>
      <div className={swap}>
        {row.spendMicros !== undefined && (
          <span
            className={cn(
              "text-xs text-muted-foreground tabular-nums",
              row.running && !stopping && revealedAway,
            )}
          >
            {spadeMoney(row.spendMicros)}
          </span>
        )}
        {row.running && !stopping && (
          <button
            type="button"
            aria-label={`Stop ${node.name}`}
            onClick={() => {
              setStopping(true);
              void props.onStop().finally(() => setStopping(false));
            }}
            className={cn(rowPill, "relative -mr-2 h-7 text-ui font-medium", revealed)}
          >
            Stop
          </button>
        )}
      </div>
    </div>
  );
}

export function WorkWorkers(props: {
  bot: RosterBot;
  tree: SpadeWorkerNode | undefined;
  rows: readonly SpadeWorkerRow[];
  roster: readonly RosterBot[];
}) {
  const { bot } = props;
  const client = useSpadeClient();
  const cache = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  if (!props.rows.length) return null;
  const spend = spadeWorkersSpend(props.tree);
  const avatarOf = (node: SpadeWorkerNode): SpadeAvatar =>
    props.roster.find((other) => other.machine.key === bot.machine.key && other.id === node.id)
      ?.avatar ?? { kind: "character", face: faceForId(node.id), raw: {} };
  const stop = async (node: SpadeWorkerNode) => {
    try {
      const thread = node.kind === "ace" ? ThreadId.safeParse(node.id) : undefined;
      if (thread?.success)
        await client.enqueue(
          { type: "thread.interrupt", threadId: thread.data, cascade: true },
          crypto.randomUUID(),
        );
      else if (node.conversation) await stopConversation(client, node.conversation);
      await cache.invalidateQueries({ queryKey: workKey(bot) });
    } catch (error) {
      toast.error({
        title: `Couldn't stop ${node.name}`,
        description: error instanceof Error ? error.message : undefined,
      });
    }
  };
  const open = (node: SpadeWorkerNode) => {
    if (node.kind === "ace") void navigate({ to: "/t/$threadId", params: { threadId: node.id } });
    else
      void navigate({
        to: "/spade/$agentId",
        params: { agentId: node.id },
        search: bot.machine.primary ? {} : { on: bot.machine.key },
      });
  };
  return (
    <ProfileSection
      label="Workers"
      actions={
        spend > 0 && (
          <span className="text-ui text-muted-foreground tabular-nums">
            {spadeMoney(spend)} in all
          </span>
        )
      }
    >
      {props.rows.map((row) => (
        <WorkerRow
          key={`${row.node.kind}:${row.node.id}`}
          row={row}
          avatar={avatarOf(row.node)}
          onOpen={() => open(row.node)}
          onStop={() => stop(row.node)}
        />
      ))}
    </ProfileSection>
  );
}

/** Each choice the bot made for the person, with its reason; Change quotes it into the composer. */
export function WorkDecisions(props: {
  decisions: readonly SpadeDecision[];
  onChange(decision: SpadeDecision): void;
}) {
  const now = useNow();
  if (!props.decisions.length) return null;
  const zone = personZone();
  return (
    <ProfileSection label="Decided for you">
      {props.decisions.map((decision) => (
        <div key={decision.id} className="group/row flex items-start gap-3 py-2.5">
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <p className="text-ui leading-5 text-foreground">{decision.choice}</p>
            {decision.reason && (
              <p className="text-xs leading-4 text-muted-foreground">{decision.reason}</p>
            )}
          </div>
          <div className={swap}>
            <span
              className={cn("text-xs leading-5 text-subtle-foreground tabular-nums", revealedAway)}
            >
              {spadeWhen(decision.at, now, zone)}
            </span>
            <button
              type="button"
              aria-label={`Change: ${decision.choice}`}
              onClick={() => props.onChange(decision)}
              className={cn(rowPill, "-my-1 -mr-2 h-7 text-ui font-medium", revealed)}
            >
              Change
            </button>
          </div>
        </div>
      ))}
    </ProfileSection>
  );
}
