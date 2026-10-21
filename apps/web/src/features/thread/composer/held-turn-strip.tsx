import type { ThreadReader } from "@ace/client";
import { useThread, useThreadMeta } from "@ace/client-react";
import type { AgentError } from "@ace/protocol";
import { describeProviderError, heldTurn, type HeldTurn, type QueueAction } from "@ace/ui-core";
import { ArrowClockwiseIcon, DotsThreeIcon, HourglassMediumIcon } from "@phosphor-icons/react";
import { useCallback, type ReactNode } from "react";
import { PauseBarsIcon, ResumeIcon } from "@/components/ace-icons.tsx";
import { Icon } from "@/components/icon.tsx";
import { Button } from "@/components/ui/button.tsx";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "@/components/ui/menu.tsx";
import { ProviderAccountIcon } from "@/components/ui/provider-account-icon.tsx";
import type { HeldQueue } from "./queue-notice.tsx";
import { useActiveRootRun } from "./stop-state.ts";
import type { QueueControls } from "./use-queue.ts";

/** The root agent's failure while it is the newest thing that happened to it. */
function useRootFailure(threadId: string): AgentError | undefined {
  const rootId = useThreadMeta(threadId)?.rootAgentId ?? "";
  const read = useCallback(
    (reader: ThreadReader) => {
      const status = reader.agent(rootId)?.status;
      return status?.state === "failed" ? status.error : undefined;
    },
    [rootId],
  );
  return useThread(threadId, [`agent:${rootId}`], read);
}

/**
 * Why the thread's turn is held, once: the queue's limit, restart or Stop hold, else the newest
 * turn ending on a usage or rate limit. Gone as soon as a turn runs again.
 */
export function useHeldTurn(threadId: string, held: HeldQueue | undefined): HeldTurn | undefined {
  const provider = useThreadMeta(threadId)?.provider;
  const failure = useRootFailure(threadId);
  const running = !!useActiveRootRun(threadId);
  const notice = held?.notice;
  // A limit holds the run it paused; a restart, a Stop or a failure is over once a turn runs.
  const limit =
    notice?.kind === "limited" || notice?.kind === "resuming" || notice?.kind === "snoozed";
  if (running && !limit) return undefined;
  const view =
    failure && !running
      ? describeProviderError({
          text: failure.message,
          code: failure.code,
          kind: failure.kind,
          title: failure.title,
          provider,
        })
      : undefined;
  return heldTurn(notice, view);
}

const glyphs = {
  restart: ArrowClockwiseIcon,
  stopped: PauseBarsIcon,
} as const;

/** Continue and Continue now carry the turn on: they wear the solid resume glyph. */
const carriesOn = (action: QueueAction) => action.id === "continue" || action.id === "resume_now";

/**
 * The held turn as the composer's colored top strip: its status hue, what happened in a word,
 * when it lifts, and its way on (Continue sends "Continue where you left off." as the person's
 * message). Further choices (resume at reset, snooze, another account) wait behind "More".
 */
export function HeldTurnStrip(props: {
  turn: HeldTurn;
  held: HeldQueue | undefined;
  queue: QueueControls;
  indicators: ReactNode;
  onChooseModel(): void;
}) {
  const { turn } = props;
  const account = props.held?.account;
  const [primary, ...rest] = turn.actions;
  const act = (action: QueueAction) =>
    action.id === "choose_model" ? props.onChooseModel() : props.queue.act(action);
  const glyph =
    turn.kind === "restart" || turn.kind === "stopped" ? glyphs[turn.kind] : HourglassMediumIcon;
  return (
    <section
      aria-label={turn.title}
      className="flex min-h-9 flex-wrap items-center gap-x-2 gap-y-1 py-1 pr-1 pl-2 text-xs"
    >
      <span className="flex size-4 shrink-0 items-center justify-center text-(--tone-text,var(--muted-foreground))">
        {turn.kind === "limited" && account ? (
          <ProviderAccountIcon provider={account.provider} account={account} size={14} />
        ) : (
          <Icon icon={glyph} size={14} />
        )}
      </span>
      <p className="min-w-0 flex-1">
        <span className="font-medium text-(--tone-text,var(--foreground))">{turn.title}</span>
        {turn.detail && <span className="text-muted-foreground"> · {turn.detail}</span>}
      </p>
      <span className="ml-auto flex shrink-0 items-center gap-0.5">
        {props.indicators}
        {rest.length > 0 && (
          <Menu>
            <MenuTrigger render={<IconButton icon={DotsThreeIcon} label="More" size="sm" />} />
            <MenuContent side="top" align="end">
              {rest.map((action) => (
                <MenuItem key={action.id} disabled={props.queue.acting} onClick={() => act(action)}>
                  {action.label}
                </MenuItem>
              ))}
            </MenuContent>
          </Menu>
        )}
        {primary && (
          <Button
            size="sm"
            variant="ghost"
            disabled={props.queue.acting}
            onClick={() => act(primary)}
            className="font-medium text-foreground"
          >
            {carriesOn(primary) && <Icon icon={ResumeIcon} size={12} />}
            {primary.label}
          </Button>
        )}
      </span>
    </section>
  );
}
