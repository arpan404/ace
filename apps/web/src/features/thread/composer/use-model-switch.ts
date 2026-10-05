import type { Thread } from "@ace/protocol";
import {
  accountTag,
  choiceSelection,
  currentModelChoice,
  recordedChoice,
  type ModelChoice,
} from "@ace/ui-core";
import { useThreadSources, type ThreadRef } from "../sources/index.ts";
import { runsNow, runsOn, selectionIdentity } from "./execution.ts";
import { choiceKind, usePendingChoice } from "./pending-choice.ts";

const modelSwitches = choiceKind<ModelChoice>();

/** When a switch takes over, while nothing more specific (offline, slow) needs saying. */
const nextTurn = "Applies at the agent's next turn";

/** A model or account switch that hasn't reached the agent yet, as the chip shows it. */
export interface WaitingSwitch {
  /** The model the thread leaves, for "Opus 4.1 → Sonnet 4.5"; undefined when only the account changes. */
  from: string | undefined;
  /** What the thread leaves and when the switch applies, for the tooltip and assistive tech. */
  description: string;
}

/** A model as the switch line names it: "Opus 4.1", or "Opus 4.1 on personal". */
const named = (choice: ModelChoice) =>
  choice.account ? `${choice.model} on ${accountTag(choice.account)}` : choice.model;

/**
 * Switching a thread to another model or account (`thread.switch`), shown at once: `chosen` is
 * the switch until the daemon reports it, and `waiting` describes any switch not yet in effect,
 * this device's or one the daemon queued for the agent's next turn. The command is durable;
 * only a refusal takes the choice back, rejecting `switchTo`.
 */
export function useModelSwitch(
  thread: ThreadRef,
  meta: Thread | undefined,
  choices: readonly ModelChoice[],
) {
  const sources = useThreadSources();
  const state = meta
    ? JSON.stringify([selectionIdentity(runsOn(meta)), meta.switch?.state, meta.switch?.at])
    : "";
  const pending = usePendingChoice(modelSwitches, thread.id, state);
  const chosen = pending.chosen?.value;
  return {
    chosen,
    /** Any switch not in effect yet, against `target`, the model the chip shows. */
    waiting(target: ModelChoice | undefined): WaitingSwitch | undefined {
      if (!meta || !target || (!chosen && meta.switch?.state !== "queued")) return undefined;
      const now = runsNow(meta);
      const from = currentModelChoice(choices, now) ?? recordedChoice(now);
      if (!from || (from.key === target.key && from.accountId === target.accountId))
        return undefined;
      return {
        from: from.model === target.model ? undefined : from.model,
        description: `Switches from ${named(from)} · ${pending.note ?? nextTurn}`,
      };
    },
    switchTo: (choice: ModelChoice) =>
      pending.choose(choice, () => sources.actions.switchTo(thread, choiceSelection(choice))),
  };
}
