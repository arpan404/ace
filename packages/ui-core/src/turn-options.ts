import type { ExecutionOptions, FollowUpBehavior, Thread, TurnOptions } from "@ace/protocol";
import { optionEffort, resolveEffort, threadEffortControl, type ModelChoice } from "./models.ts";
import { nextOptions } from "./model-picker.ts";
import { speedControl, speedOption, type Speed } from "./speed.ts";
import {
  changedTurnOptions,
  runsOn,
  selectionIdentity,
  type PendingTurn,
} from "./thread-execution.ts";

/*
 * Effort and speed on a thread that already runs: what its composer offers, how a pick changes
 * the next message's options, and which options a message carries when it is sent. Shared by
 * the web composer and the native clients' bridges. Pure over the thread record and the model
 * the catalog says it runs on.
 */

const none: ExecutionOptions = {};
/** The effort a selection's options name, when they name one. */
const named = (options: ExecutionOptions | undefined) =>
  typeof options?.["effort"] === "string" ? options["effort"] : undefined;

/** The thread's effort and speed controls, given what the person picked for the next message. */
export function threadTuning(input: {
  thread: Thread | undefined;
  /** The catalog's choice for what the thread runs on, else its recorded selection. */
  choice: ModelChoice | undefined;
  /** Options picked for the next message, when picked for this selection. */
  pending: ExecutionOptions | undefined;
}) {
  const { thread, choice } = input;
  const base = runsOn(thread)?.options ?? none;
  const options = input.pending ?? base;
  const preset = resolveEffort(choice?.efforts ?? [], undefined, choice?.defaultEffort);
  const capabilities = thread?.capabilities;
  const effort = threadEffortControl({ choice, capabilities, current: optionEffort(options) });
  const speed = speedControl({
    model: choice && {
      label: choice.model,
      provider: choice.provider,
      speeds: choice.speeds,
      defaultSpeed: choice.defaultSpeed,
    },
    current: options["serviceTier"],
    capabilities,
    running: true,
  });
  return { base, options, preset, effort, speed };
}
export type ThreadTuning = ReturnType<typeof threadTuning>;

/**
 * The next message's options after picking an effort (undefined: the provider's default). Back
 * to the default where the thread's own selection names an effort goes out by name, since the
 * provider keeps a named effort unless told otherwise. Undefined when nothing differs.
 */
export function pickEffort(tuning: ThreadTuning, effort: string | undefined) {
  return nextOptions(tuning.base, tuning.options, {
    effort: effort ?? (optionEffort(tuning.base) === undefined ? undefined : tuning.preset),
  });
}

/** The next message's options after picking a speed; undefined when nothing differs. */
export function pickSpeed(tuning: ThreadTuning, speed: Speed) {
  return nextOptions(tuning.base, tuning.options, {
    serviceTier: speedOption(tuning.speed.tiers, speed),
  });
}

/**
 * The options a follow-up carries. Options picked for another selection never go. While the
 * agent works only what differs from what it runs with goes (a steer leaves the running turn
 * as it is); otherwise the effort is named, so the next turn runs at what the composer showed.
 */
export function followUpTurnOptions(input: {
  thread: Thread | undefined;
  choice: ModelChoice | undefined;
  pending: PendingTurn | undefined;
  busy: boolean;
  delivery: FollowUpBehavior | undefined;
}): TurnOptions | undefined {
  const selection = runsOn(input.thread);
  const sent = input.pending?.identity === selectionIdentity(selection) ? input.pending : undefined;
  const efforts = input.choice?.efforts ?? [];
  if (input.busy) {
    const inheritedEffort = resolveEffort(
      efforts,
      named(selection?.options),
      input.choice?.defaultEffort,
    );
    const pendingEffort =
      sent && resolveEffort(efforts, named(sent.options), input.choice?.defaultEffort);
    const picked = sent && {
      ...sent.options,
      ...(pendingEffort !== undefined ? { effort: pendingEffort } : {}),
    };
    return changedTurnOptions(picked, {
      ...selection?.options,
      ...(inheritedEffort !== undefined ? { effort: inheritedEffort } : {}),
    });
  }
  const explicit = sent?.options ?? selection?.options;
  const effort = resolveEffort(efforts, named(explicit), input.choice?.defaultEffort);
  return input.delivery !== "steer" &&
    effort !== undefined &&
    (explicit?.["effort"] === undefined || efforts.includes(String(explicit["effort"])))
    ? { ...explicit, effort }
    : sent?.options;
}
