import type { ThreadReader } from "@ace/client";
import { useThread, useThreadMeta } from "@ace/client-react";
import type { AgentError } from "@ace/protocol";
import {
  describeProviderError,
  heldTurn,
  heldTurnLink,
  providerNames,
  type HeldTurn,
} from "@ace/ui-core";
import { useCallback, type ReactNode } from "react";
import { useNow } from "@/lib/time.ts";
import type { HeldQueue } from "./queue-notice.tsx";
import { useActiveRootRun } from "./stop-state.ts";
import { useChosenModel } from "./use-model-switch.ts";
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
  const leaving = useLeavesLimit(threadId);
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
  const who = provider ? providerNames[provider] : "The provider";
  return leaving ? undefined : heldTurn(held?.notice, view, who, now);
}

/**
 * The person picked a model on an account with room (shown at once, before the daemon has it),
 * or a switch is on its way: the limit is the old account's, so it stops showing and their next
 * message goes straight out on the new selection.
 */
export function useLeavesLimit(threadId: string): boolean {
  const chosen = useChosenModel(threadId);
  const queued = useThreadMeta(threadId)?.switch?.state === "queued";
  return chosen ? !chosen.exhausted : queued;
}

/**
 * The limit as the composer's top strip: one sentence and the ways on, as words. "Codex is out
 * of usage until 1:14 AM · Switch · Resume at reset · Continue". Switch opens the picker for
 * another account, model or provider. Continue
 * sends "Continue where you left off." as the person's message.
 */
export function HeldTurnStrip(props: {
  threadId: string;
  turn: HeldTurn;
  queue: QueueControls;
  indicators: ReactNode;
  onSwitch(): void;
}) {
  const { turn } = props;
  return (
    <section
      aria-label={turn.lead}
      className="flex h-9 min-w-0 items-center gap-1 pr-1 pl-2.5 text-xs"
    >
      <p className="min-w-0 flex-1 truncate text-muted-foreground">
        {turn.lead}
        {turn.until && (
          <>
            {heldTurnLink(turn)}
            <span className="font-medium text-foreground tabular-nums">{turn.until}</span>
          </>
        )}
      </p>
      {props.indicators}
      <button
        type="button"
        onClick={props.onSwitch}
        className="h-7 shrink-0 rounded-md px-2 font-medium text-muted-foreground transition-colors duration-(--motion-fast) hover:bg-accent hover:text-foreground focus-ring"
      >
        Switch
      </button>
      {turn.atReset && (
        <button
          type="button"
          disabled={props.queue.acting}
          onClick={() => turn.atReset && props.queue.act(turn.atReset)}
          className="h-7 shrink-0 rounded-md px-2 font-medium text-muted-foreground transition-colors duration-(--motion-fast) hover:bg-accent hover:text-foreground focus-ring disabled:opacity-50"
        >
          Resume at reset
        </button>
      )}
      <button
        type="button"
        disabled={props.queue.acting}
        onClick={() => props.queue.act(turn.carryOn)}
        className="h-7 shrink-0 rounded-md px-2 font-semibold text-foreground transition-colors duration-(--motion-fast) hover:bg-accent focus-ring disabled:opacity-50"
      >
        Continue
      </button>
    </section>
  );
}
