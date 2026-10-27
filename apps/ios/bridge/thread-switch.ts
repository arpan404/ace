import type { CommandPayload, Thread, ThreadId } from "@ace/protocol";
import {
  choiceSelection,
  currentModelChoice,
  switchQuestion,
  switchUnsupportedNote,
  threadForkSwitchRoute,
  threadSwitchRoute,
  type ModelChoice,
  type SwitchQuestion,
  type SwitchRoute,
} from "@ace/ui-core";
import { runsOn } from "@ace/ui-core/thread-execution";

/*
 * Moving an open thread to another model, account or provider, by the web's rules
 * (`threadSwitchRoute`, or `threadForkSwitchRoute` unless `threads.forkOnSwitch` is off): the
 * same provider switches in place at once; another provider in place asks first, since the
 * agent's own state stays behind; a route to a new thread asks, then waits for the person's next
 * message; an unsupported one is refused. The questions are the shared `switchQuestion`. Pure
 * over the thread and the catalog's choices.
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
  busy: boolean;
  /** Why the message being written can't go to a new thread on `choice`, if it can't. */
  carryProblem: (choice: ModelChoice) => string | undefined;
}

/** A scene with what every row is measured against worked out once. */
export interface ShapedScene extends SwitchScene {
  /** What the thread runs on next (a queued switch included), as the catalog lists it. */
  running: ModelChoice | undefined;
  /** The row the picker checks: a continuation, else a switch on its way, else what runs. */
  picked: ModelChoice | undefined;
  byRow: ReadonlyMap<string, ModelChoice>;
}

export type SwitchPlan =
  | { kind: "stay" }
  /** Back to what the thread runs on: the continuation is no longer wanted. */
  | { kind: "back" }
  /** `note` is what the picker says beside it. */
  | { kind: "refused"; message: string; note: string }
  | { kind: "switch"; choice: ModelChoice; ask: SwitchQuestion | undefined }
  | { kind: "continue"; choice: ModelChoice; ask: SwitchQuestion };

const rowId = (key: string, account: string) => `${account}\u0000${key}`;

export function shapeScene(scene: SwitchScene): ShapedScene {
  const running = currentModelChoice(scene.choices, runsOn(scene.thread));
  return {
    ...scene,
    running,
    picked: scene.continued ?? scene.chosen ?? running,
    byRow: new Map(scene.choices.map((choice) => [rowId(choice.key, choice.accountId), choice])),
  };
}

function routeTo(scene: SwitchScene, choice: ModelChoice): SwitchRoute {
  const route = scene.forkOnSwitch === false ? threadSwitchRoute : threadForkSwitchRoute;
  return route(scene.thread, choice);
}

/** The question to ask before moving to `choice` by `route`; undefined moves at once. */
function switchAsk(
  scene: SwitchScene,
  choice: ModelChoice,
  route: SwitchRoute,
): SwitchQuestion | undefined {
  // The provider the thread is on, or is moving to by a switch sent from here.
  const from = scene.chosen?.provider ?? runsOn(scene.thread)?.provider ?? scene.thread.provider;
  const continues = route === "new_thread";
  if (!continues && (route !== "in_place" || choice.provider === from)) return undefined;
  return switchQuestion({
    from,
    to: choice,
    busy: scene.busy,
    continues,
    warning: continues ? scene.carryProblem(choice) : undefined,
  });
}

/** What picking `target` does. The daemon refuses a `thread.switch` by the same route. */
export function switchPlan(scene: ShapedScene, target: SwitchTarget): SwitchPlan {
  const choice = scene.byRow.get(rowId(target.key, target.account));
  if (!choice)
    return {
      kind: "refused",
      message: "That model isn't offered now. Pick another.",
      note: "Not available now",
    };
  if (choice.id === scene.picked?.id) return { kind: "stay" };
  if (scene.continued && choice.id === scene.running?.id) return { kind: "back" };
  const route = routeTo(scene, choice);
  if (route === "unsupported")
    return {
      kind: "refused",
      message: `This thread can't move there. ${switchUnsupportedNote}.`,
      note: switchUnsupportedNote,
    };
  const ask = switchAsk(scene, choice, route);
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
  asks: SwitchQuestion[];
}

export function switchRows(scene: ShapedScene, targets: readonly SwitchTarget[]): SwitchRows {
  const rows: SwitchRows["rows"] = {};
  const asks: SwitchQuestion[] = [];
  const index = new Map<string, number>();
  for (const target of targets) {
    const plan = switchPlan(scene, target);
    const id = rowId(target.key, target.account);
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
