import type { ThreadReader } from "@ace/client";
import { useThread, useThreadMeta } from "@ace/client-react";
import type { AgentError } from "@ace/protocol";
import {
  carryingTurn,
  describeProviderError,
  heldTurn,
  providerNames,
  scheduledLead,
  type HeldTurn,
} from "@ace/ui-core";
import { useCallback, type ReactNode } from "react";
import { useNow } from "@/lib/time.ts";
import type { HeldQueue } from "./queue-notice.tsx";
import { useActiveRootRun } from "./stop-state.ts";
import { useCarryOn } from "./use-carry-on.ts";
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
  const failureProvider = failure?.details?.provider;
  const view =
    failure && !running && (!failureProvider || failureProvider === provider)
      ? describeProviderError({
          text: failure.message,
          code: failure.code,
          kind: failure.kind,
          title: failure.title,
          provider,
        })
      : undefined;
  const who = provider ? providerNames[provider] : "The provider";
  const { carrying } = useCarryOn(threadId);
  if (carrying) return carryingTurn(carrying.name);
  const explicitlyHeld = held && !["limited", "resuming", "snoozed"].includes(held.notice.kind);
  return leaving || explicitlyHeld ? undefined : heldTurn(held?.notice, view, who, now);
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

const textButton =
  "h-7 shrink-0 rounded-md px-2 font-medium text-muted-foreground transition-colors duration-(--motion-fast) hover:bg-accent hover:text-foreground focus-ring disabled:opacity-50";

/** A time in the strip's sentence, in the foreground ink. */
function Time(props: { children: string }) {
  return <span className="font-medium text-foreground tabular-nums">{props.children}</span>;
}

/** The strip's sentence. */
function Sentence(props: { turn: HeldTurn }) {
  const { turn } = props;
  if (turn.scheduled && turn.until)
    return (
      <>
        {scheduledLead(turn)}
        <Time>{turn.until}</Time> when {turn.who} resets
        {turn.left && <span className="tabular-nums"> · in {turn.left}</span>}
      </>
    );
  return (
    <>
      {turn.lead}
      {turn.until && (
        <>
          {" "}
          until <Time>{turn.until}</Time>
        </>
      )}
    </>
  );
}

/**
 * The limit as the composer's top strip: one sentence and the ways on, as words. "Codex is out
 * of usage until 1:14 AM · Switch · Resume at reset · Continue". Switch opens the model picker
 * on an account with room; a pick there carries the held work on at once. Once the person chose
 * to resume at reset: "Resumes at 1:14 AM when Codex resets · in 1h 28m · Switch · Cancel", where
 * Cancel goes back to the limit. While a switch lands: "Continuing on Claude Code · work".
 */
export function HeldTurnStrip(props: {
  threadId: string;
  turn: HeldTurn;
  queue: QueueControls;
  indicators: ReactNode;
  /** Opens the model picker on its list; a pick carries the held work on there. */
  onSwitch(): void;
}) {
  const { turn, queue } = props;
  const moving = turn.kind === "moving";
  return (
    <section
      aria-label={turn.scheduled ? "Scheduled resume" : turn.lead}
      // The sentence is never cut: when the strip is too narrow for it and the actions on one
      // line, the actions move to a second line, still at the right.
      className="flex min-h-9 min-w-0 flex-wrap items-center gap-x-1 py-1 pr-1 pl-2.5 text-xs"
    >
      <p
        role={moving ? "status" : undefined}
        className="min-w-[14rem] flex-1 py-1 text-muted-foreground"
      >
        <Sentence turn={turn} />
      </p>
      <div className="ml-auto flex shrink-0 items-center gap-1">
        {props.indicators}
        {!moving && (
          <button
            type="button"
            disabled={queue.acting}
            onClick={props.onSwitch}
            className={textButton}
          >
            Switch
          </button>
        )}
        {turn.cancel ? (
          <button
            type="button"
            disabled={queue.acting}
            onClick={() => turn.cancel && queue.act(turn.cancel)}
            className={textButton}
          >
            Cancel
          </button>
        ) : (
          !moving && (
            <>
              {turn.atReset && (
                <button
                  type="button"
                  disabled={queue.acting}
                  onClick={() => turn.atReset && queue.act(turn.atReset)}
                  className={textButton}
                >
                  Resume at reset
                </button>
              )}
              <button
                type="button"
                disabled={queue.acting}
                onClick={() => queue.act(turn.carryOn)}
                className="h-7 shrink-0 rounded-md px-2 font-semibold text-foreground transition-colors duration-(--motion-fast) hover:bg-accent focus-ring disabled:opacity-50"
              >
                Continue
              </button>
            </>
          )
        )}
      </div>
    </section>
  );
}
