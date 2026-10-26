import type { CommandPayload, Thread, ThreadId } from "@ace/protocol";
import {
  choiceSelection,
  currentModelChoice,
  providerNames,
  switchUnsupportedNote,
  threadForkSwitchRoute,
  threadSwitchRoute,
  type ModelChoice,
  type SwitchRoute,
} from "@ace/ui-core";
import { runsOn } from "@ace/ui-core/thread-execution";

/*
 * Moving an open thread to another model, account or provider, by the web's rules
 * (`threadSwitchRoute`, or `threadForkSwitchRoute` unless `threads.forkOnSwitch` is off): the
 * same provider switches in place at once; another provider in place asks first, since the
 * agent's own state stays behind; a route to a new thread asks, then waits for the person's next
 * message; an unsupported one is refused. Pure over the thread and the catalog's choices.
 */

/** A row of the picker: a model on one account (`ModelChoice.key` and `accountId`). */
export interface SwitchTarget {
  key: string;
  account: string;
}

export interface SwitchScene {
  thread: Thread;
  choices: readonly ModelChoice[];
  /** `threads.forkOnSwitch`; until it is read the source is preserved, as on the web. */
  forkOnSwitch: boolean | undefined;
  /** A switch sent from here that the daemon hasn't reported yet. */
  chosen: ModelChoice | undefined;
  /** A model the next message continues on, in a new thread. */
  continued: ModelChoice | undefined;
}

/** What the person confirms before the move, in words. */
export interface SwitchAsk {
  title: string;
  message: string;
  action: string;
}

export type SwitchPlan =
  | { kind: "stay" }
  /** Back to what the thread runs on: the continuation is no longer wanted. */
  | { kind: "back" }
  /** `note` is what the picker says beside it. */
  | { kind: "refused"; message: string; note: string }
  | { kind: "switch"; choice: ModelChoice; ask: SwitchAsk | undefined }
  | { kind: "continue"; choice: ModelChoice; ask: SwitchAsk };

export function findChoice(
  choices: readonly ModelChoice[],
  target: SwitchTarget,
): ModelChoice | undefined {
  return choices.find((choice) => choice.key === target.key && choice.accountId === target.account);
}

/** The catalog's row for what the thread runs on next (a queued switch included). */
export function runningChoice(scene: Pick<SwitchScene, "thread" | "choices">) {
  return currentModelChoice(scene.choices, runsOn(scene.thread));
}

/** The row the picker checks: a continuation, else a switch on its way, else what runs. */
export function pickedChoice(scene: SwitchScene): ModelChoice | undefined {
  return scene.continued ?? scene.chosen ?? runningChoice(scene);
}

export function routeTo(scene: SwitchScene, choice: ModelChoice): SwitchRoute {
  const route = scene.forkOnSwitch === false ? threadSwitchRoute : threadForkSwitchRoute;
  return route(scene.thread, choice);
}

/** The provider the thread is on, or is moving to by a switch sent from here. */
function providerNow(scene: SwitchScene) {
  return scene.chosen?.provider ?? runsOn(scene.thread)?.provider ?? scene.thread.provider;
}

/** What to ask before moving to `choice` by `route`; undefined moves at once. */
export function switchAsk(
  scene: SwitchScene,
  choice: ModelChoice,
  route: SwitchRoute,
  busy: boolean,
): SwitchAsk | undefined {
  const to = providerNames[choice.provider];
  if (route === "new_thread")
    return {
      title: "Continue in a new thread?",
      message: `Your next message starts a new thread on ${to}, with this conversation as its context. This thread stays as it is.`,
      action: "Continue",
    };
  const from = providerNow(scene);
  if (route !== "in_place" || choice.provider === from) return undefined;
  return {
    title: `Switch to ${to}?`,
    message:
      `${to} picks up from a summary of this conversation. What ${providerNames[from]} kept to itself, its own session state, stays behind.` +
      (busy ? " The switch happens once the current turn finishes." : ""),
    action: "Switch",
  };
}

/** What picking `target` does. The daemon refuses a `thread.switch` by the same route. */
export function switchPlan(scene: SwitchScene, target: SwitchTarget, busy: boolean): SwitchPlan {
  const choice = findChoice(scene.choices, target);
  if (!choice)
    return {
      kind: "refused",
      message: "That model isn't offered now. Pick another.",
      note: "Not available now",
    };
  if (choice.id === pickedChoice(scene)?.id) return { kind: "stay" };
  if (scene.continued && choice.id === runningChoice(scene)?.id) return { kind: "back" };
  const route = routeTo(scene, choice);
  if (route === "unsupported")
    return {
      kind: "refused",
      message: `This thread can't move there. ${switchUnsupportedNote}.`,
      note: switchUnsupportedNote,
    };
  const ask = switchAsk(scene, choice, route, busy);
  if (route === "new_thread" && ask) return { kind: "continue", choice, ask };
  return { kind: "switch", choice, ask };
}

/** The command that moves the thread to `choice` from its next turn. */
export function switchPayload(threadId: ThreadId, choice: ModelChoice): CommandPayload {
  return { type: "thread.switch", threadId, selection: choiceSelection(choice) };
}

/** Rows that don't simply switch: why they can't be picked, or which question they ask. */
export interface SwitchRows {
  /** By picker row id (`account` NUL `key`): an index into `asks`, or the note it can't be picked for. */
  rows: Record<string, { ask: number | null; note: string | null }>;
  asks: SwitchAsk[];
}

export function switchRows(
  scene: SwitchScene,
  targets: readonly SwitchTarget[],
  busy: boolean,
): SwitchRows {
  const rows: SwitchRows["rows"] = {};
  const asks: SwitchAsk[] = [];
  const index = new Map<string, number>();
  for (const target of targets) {
    const plan = switchPlan(scene, target, busy);
    const id = `${target.account}\u0000${target.key}`;
    if (plan.kind === "refused") rows[id] = { ask: null, note: plan.note };
    if ((plan.kind !== "switch" && plan.kind !== "continue") || !plan.ask) continue;
    const said = JSON.stringify(plan.ask);
    let at = index.get(said);
    if (at === undefined) {
      at = asks.push(plan.ask) - 1;
      index.set(said, at);
    }
    rows[id] = { ask: at, note: null };
  }
  return { rows, asks };
}
