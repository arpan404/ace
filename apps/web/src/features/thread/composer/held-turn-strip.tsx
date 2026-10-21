import type { ThreadReader } from "@ace/client";
import { useThread, useThreadMeta } from "@ace/client-react";
import type { AgentError } from "@ace/protocol";
import { describeProviderError, heldTurn, providerNames, type HeldTurn } from "@ace/ui-core";
import { useCallback, useEffect, useEffectEvent, useRef, type ReactNode } from "react";
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
  const who = provider ? providerNames[provider] : "The provider";
  return heldTurn(held?.notice, view, who, now);
}

/**
 * While a limit holds the thread, a switch to another account, model or provider carries the
 * work on at once: the new agent starts from the handoff without waiting for another Continue.
 * Only a switch made after the hold showed counts, and a refused one never does.
 */
export function useContinueOnSwitch(
  threadId: string,
  turn: HeldTurn | undefined,
  queue: QueueControls,
): void {
  const change = useThreadMeta(threadId)?.switch;
  const seen = useRef(change?.at);
  const carryOn = useEffectEvent(() => {
    if (turn) queue.act(turn.carryOn);
  });
  useEffect(() => {
    if (change?.at === seen.current) return;
    seen.current = change?.at;
    if (change && change.state !== "failed") carryOn();
  }, [change]);
}

/**
 * The limit as the composer's top strip, one sentence and two words to act on: "Codex is out
 * of usage until 1:14 AM · Switch account or provider · Continue". Continue sends "Continue
 * where you left off." as the person's message.
 */
export function HeldTurnStrip(props: {
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
            {" until "}
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
        Switch account or provider
      </button>
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
