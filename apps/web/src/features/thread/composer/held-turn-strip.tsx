import type { ThreadReader } from "@ace/client";
import { useThread, useThreadMeta } from "@ace/client-react";
import type { AgentError } from "@ace/protocol";
import { describeProviderError, heldTurn, type HeldTurn, type QueueAction } from "@ace/ui-core";
import { DotsThreeIcon, HourglassMediumIcon } from "@phosphor-icons/react";
import { useCallback, type ReactNode } from "react";
import { ResumeIcon } from "@/components/ace-icons.tsx";
import { Icon } from "@/components/icon.tsx";
import { Button } from "@/components/ui/button.tsx";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "@/components/ui/menu.tsx";
import { useNow } from "@/lib/time.ts";
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
 * The usage or rate limit holding the thread: the queue's limit hold (it holds the run it
 * paused), else the newest turn that ended on a limit with nothing run since.
 */
export function useHeldTurn(threadId: string, held: HeldQueue | undefined): HeldTurn | undefined {
  const provider = useThreadMeta(threadId)?.provider;
  const failure = useRootFailure(threadId);
  const running = !!useActiveRootRun(threadId);
  const now = useNow();
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
  return heldTurn(held?.notice, view, now);
}

/**
 * A limit as the composer's colored top strip, on one line: "Usage limit reached · Resets in
 * 1h 28m", then Continue (it sends "Continue where you left off." as the person's message).
 * Resume at reset, snooze and another account wait behind the menu.
 */
export function HeldTurnStrip(props: {
  turn: HeldTurn;
  queue: QueueControls;
  indicators: ReactNode;
  onChooseModel(): void;
}) {
  const { turn } = props;
  const [primary, ...rest] = turn.actions;
  const act = (action: QueueAction) =>
    action.id === "choose_model" ? props.onChooseModel() : props.queue.act(action);
  return (
    <section
      aria-label={turn.title}
      className="flex h-9 min-w-0 items-center gap-2 pr-1 pl-2 text-xs"
    >
      <Icon icon={HourglassMediumIcon} size={14} className="shrink-0 text-(--tone-text)" />
      <p className="min-w-0 flex-1 truncate">
        <span className="font-medium text-(--tone-text)">{turn.title}</span>
        {turn.detail && <span className="text-muted-foreground"> · {turn.detail}</span>}
      </p>
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
          className="shrink-0 font-medium text-foreground"
        >
          {primary.id === "resume_now" || primary.id === "continue" ? (
            <Icon icon={ResumeIcon} size={12} />
          ) : null}
          {primary.label}
        </Button>
      )}
    </section>
  );
}
