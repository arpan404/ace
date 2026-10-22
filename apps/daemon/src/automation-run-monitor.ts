import { createHash } from "node:crypto";
import type { ExecutionResult } from "@ace/automations";
import {
  BackgroundTaskId,
  Command,
  CommandId,
  type CommandPayload,
  type CommandResult,
  type DeviceId,
  type Thread,
  type ThreadId,
} from "@ace/protocol";
import { commandContext } from "./commands.ts";
import type { ServiceContext } from "./services/types.ts";
import { readTreeMembers } from "./thread-tree.ts";
import { systemClock } from "./engine/actor.ts";
import {
  decideRun,
  runTreeState,
  stopPlan,
  type StopPlan,
  type TreeState,
} from "./automation-run-rules.ts";
import {
  activeRootRun,
  readRunAnswer,
  readTurn,
  readTurnWork,
  turnDelegations,
  type TurnRead,
} from "./automation-run-facts.ts";
import type { RunRecord, RunRecords } from "./automation-run-record.ts";
import type { DelegationJournal } from "./agent-control/journal.ts";

/** A check now and then in case a change came without an event the monitor listens for. */
const reconcileMs = 5_000;
/** How many times a stop whose delivery fails is sent before the run says it can't be stopped. */
const stopTries = 5;

/**
 * How the host stops a run's work in the delegation service, when there is one: a Stop of the
 * run's turn without the marker a person's Stop leaves (`hostStop`), and the ordinary cascading
 * cancel of delegated threads wholly the run's, whose results never wake the thread (`hostCancel`).
 */
export interface HostStop {
  /** Whose delegations an automation's runs can see and cancel. */
  journal: DelegationJournal;
  stop(thread: ThreadId, command: Command): CommandResult;
  cancel(
    children: readonly ThreadId[],
    reservations: readonly ThreadId[],
    request: string,
  ): boolean;
}

export interface FollowOptions {
  records: RunRecords;
  deviceId: DeviceId;
  hostStop: () => HostStop | undefined;
  /** Lets the executor wake this run's monitor, as when a stop is asked for. */
  register(commandId: CommandId, wake: () => void): () => void;
}

const watched = new Set([
  "thread.updated",
  "thread.client.updated",
  "queue.updated",
  "run.started",
  "run.ended",
  "item.created",
  "item.updated",
  "item.deleted",
]);

/**
 * Follow one automation run from its record until it settles, carrying out its cancellation
 * on the way. The run is the turn its message started (see `automation-run-rules.ts`): it
 * settles once that turn's root runs ended and nothing the turn began still works or waits on
 * the person, and its result is that turn's own answer. Changes in the run's threads wake it;
 * a slow timer covers anything else.
 */
export function followRun(
  context: ServiceContext,
  options: FollowOptions,
  commandId: CommandId,
  signal: AbortSignal,
): Promise<ExecutionResult> {
  const { store } = context;
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    let settled = false;
    let running = false;
    let dirty = false;
    // The run's own thread from the start, so no change in it is missed before the first look.
    const own = options.records.get(commandId)?.threadId;
    let members = new Set<ThreadId>(own ? [own] : []);
    let cancelTimer = noop;
    const clock = context.options.engine?.clock ?? systemClock;
    const close = () => {
      settled = true;
      cancelTimer();
      unsubscribe();
      unregister();
      signal.removeEventListener("abort", abort);
    };
    const abort = () => {
      close();
      reject(signal.reason);
    };
    const finish = (result: ExecutionResult) => {
      close();
      resolve(result);
    };
    const step = async () => {
      try {
        do {
          dirty = false;
          const result = await inspect(context, options, commandId);
          if (settled) return;
          members = result.members;
          if (result.done) {
            finish(result.done);
            return;
          }
          if (result.again) dirty = true;
        } while (dirty);
      } catch (error) {
        context.log.log("error", "Automation run check failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      } finally {
        running = false;
      }
    };
    const wake = () => {
      if (settled) return;
      if (running) {
        dirty = true;
        return;
      }
      running = true;
      queueMicrotask(() => void step());
    };
    const unsubscribe = store.subscribe((events) => {
      if (events.some((event) => members.has(event.threadId) && watched.has(event.payload.type)))
        wake();
    });
    const unregister = options.register(commandId, wake);
    signal.addEventListener("abort", abort, { once: true });
    const refresh = () => {
      wake();
      if (!settled) cancelTimer = clock.setTimer(refresh, reconcileMs);
    };
    refresh();
  });
}

function noop(): void {}

interface Inspection {
  members: Set<ThreadId>;
  done?: ExecutionResult;
  /** Something changed that calls for another look straight away. */
  again?: boolean;
}

async function inspect(
  context: ServiceContext,
  options: FollowOptions,
  commandId: CommandId,
): Promise<Inspection> {
  const { store, services } = context;
  const record = options.records.get(commandId);
  const threadId = record?.threadId;
  if (!record || !threadId || !record.inputCommand) return { members: new Set() };
  const members = new Set<ThreadId>([threadId]);
  const thread = store.getThread(threadId);
  if (!thread || thread.deletedAt !== undefined) {
    await store.write(() => options.records.settle(commandId));
    return {
      members,
      done: {
        threadId,
        status: "failed",
        result: "Its thread was deleted before the run finished.",
      },
    };
  }
  const engine = services.engine;
  if (!engine) throw new Error("engine_unavailable");
  const fate = engine.inputFate(threadId, record.inputCommand);
  if (fate.state === "replaced") {
    await store.write(() => options.records.replace(commandId, fate.by));
    return { members, again: true };
  }
  const bound = fate.state === "delivered" ? fate.runId : undefined;
  if (fate.state !== record.disposition || (bound !== undefined && bound !== record.engineRun))
    await store.write(() => options.records.observe(commandId, fate.state, bound));
  const runId = bound ?? record.engineRun;
  const turn =
    runId === undefined ? undefined : readTurn(store, threadId, runId, thread.rootAgentId);
  let tree: TreeState | undefined;
  if (turn && !turn.facts.active) {
    const journal = options.hostStop()?.journal;
    const open = readOpenWork(context, journal, threadId, turn, thread.rootAgentId);
    for (const child of [
      ...(open?.delegations.children ?? []),
      ...(open?.delegations.uncertain ?? []),
    ])
      members.add(child);
    tree =
      open === undefined
        ? "uncertain"
        : runTreeState({
            root: turn.later ? undefined : readTreeMembers(context, [threadId], journal)[0],
            work: {
              tasks: open.work.tasks.length,
              agentRuns: open.work.agentRuns.length,
              questions: open.work.questions,
              reservations: open.delegations.reservations.length,
              unowned: open.delegations.uncertain.length,
              continuing: open.work.continuing,
            },
            children: readTreeMembers(context, open.delegations.children, journal),
            cancelling: record.cancel !== undefined,
          });
  }
  // A stop just sent changes what the run is: look again before deciding anything.
  if (
    (record.cancel === "requested" || record.cancel === "sent") &&
    (await reconcileStop(context, options, commandId, thread))
  )
    return { members, again: true };
  const latest = options.records.get(commandId) ?? record;
  const decision = decideRun({
    threadDeleted: false,
    fate,
    boundRun: runId,
    cancel: latest.cancel === "acknowledged" ? undefined : latest.cancel,
    stopReached:
      latest.cancel !== undefined && (latest.stopTarget !== undefined || latest.stopAttempts > 0),
    stopError: latest.stopError,
    turn: turn?.facts,
    tree,
  });
  if (decision.kind === "wait") return { members };
  if (decision.kind === "follow") {
    await store.write(() => options.records.replace(commandId, decision.commandId));
    return { members, again: true };
  }
  const answer =
    decision.result ??
    (turn ? readRunAnswer(store, threadId, thread.rootAgentId, turn) : undefined) ??
    decision.fallback ??
    "";
  await store.write(() => options.records.settle(commandId));
  return { members, done: { threadId, status: decision.status, result: answer } };
}

/**
 * Carry out the run's cancellation as things stand now, reading them again inside the write
 * that sends the stop, so it can only reach the run's own message, turn or children. Returns
 * whether a stop was sent, so the run is looked at again before anything is decided.
 */
async function reconcileStop(
  context: ServiceContext,
  options: FollowOptions,
  commandId: CommandId,
  thread: Thread,
): Promise<boolean> {
  const { store, services } = context;
  return store.write(() => {
    const record = options.records.get(commandId);
    const engine = services.engine;
    if (!record?.threadId || !record.inputCommand || !engine) return false;
    if (record.cancel !== "requested" && record.cancel !== "sent") return false;
    const threadId = record.threadId;
    // Admitted is not delivered: a stop the engine failed to deliver is sent again, as a new
    // command after a backoff, until it gets through or the tries run out.
    const failure = record.stopCommands
      .map((id) => engine.commandFailure(id))
      .find((error) => error !== undefined);
    if (failure !== undefined) {
      const attempts = record.stopAttempts + 1;
      options.records.stopFailed(
        commandId,
        failure,
        attempts < stopTries ? context.now() + Math.min(60_000, 1000 * 2 ** attempts) : undefined,
      );
      return false;
    }
    if (record.stopError !== undefined) return false;
    if (record.stopRetryAt !== undefined && context.now() < record.stopRetryAt) return false;
    const fate = engine.inputFate(threadId, record.inputCommand);
    const bound = (fate.state === "delivered" ? fate.runId : undefined) ?? record.engineRun;
    const turn =
      bound === undefined ? undefined : readTurn(store, threadId, bound, thread.rootAgentId);
    const active = activeRootRun(store, threadId, thread.rootAgentId);
    const journal = options.hostStop()?.journal;
    const open = turn
      ? readOpenWork(context, journal, threadId, turn, thread.rootAgentId)
      : undefined;
    const plan = stopPlan({
      fate,
      boundRun: record.engineRun,
      rootActive:
        active === undefined
          ? undefined
          : { runId: active, ours: turn?.runIds.includes(active) ?? false },
      // Only tasks the engine can stop on their own; the others are left to end.
      tasks: open?.work.tasks.filter((task) => task.stoppable).map((task) => task.id) ?? [],
      agentRuns: open?.work.agentRuns ?? [],
      // Only children whose whole subtree is the run's; others are left to end on their own.
      liveChildren: open?.delegations.stoppable ?? [],
      reservations: open?.delegations.stoppableReservations ?? [],
    });
    if (plan.kind === "wait") return false;
    if (plan.kind === "none") {
      if (record.cancel === "requested") options.records.stopSent(commandId, undefined);
      return false;
    }
    const target = planTarget(plan, record);
    if (target === record.stopTarget) return false;
    const stopId = CommandId.parse(
      `automation-stop-${createHash("sha256").update(`${commandId}:${record.version}`).digest("hex")}`,
    );
    const sent: CommandId[] = [];
    const accepted = sendStop(context, options, threadId, record, plan, stopId, sent);
    if (accepted) options.records.stopSent(commandId, target, sent);
    else options.records.stopRefused(commandId);
    // A refused stop changed nothing: the next change in the thread, or the slow check, retries.
    return accepted;
  });
}

/** The turn's open work: native work in its thread, and the delegations it began. */
function readOpenWork(
  context: ServiceContext,
  journal: DelegationJournal | undefined,
  threadId: ThreadId,
  turn: TurnRead,
  rootAgentId: string | undefined,
) {
  const delegations = turnDelegations(context.store, journal, threadId, turn);
  if (!delegations) return undefined;
  return { work: readTurnWork(context.store, threadId, turn, rootAgentId), delegations };
}

function planTarget(plan: Exclude<StopPlan, { kind: "wait" | "none" }>, record: RunRecord) {
  switch (plan.kind) {
    case "remove":
      return `remove:${record.inputCommand}`;
    case "interrupt":
      return `interrupt:${plan.runId}`;
    case "stop-work":
      return `work:${[
        ...plan.tasks.map((id) => `task:${id}`),
        ...plan.agentRuns.map((run) => `run:${run.runId}`),
        ...plan.children.map((id) => `child:${id}`),
        ...plan.reservations.map((id) => `reserved:${id}`),
      ].join(",")}`;
  }
}

/** Send the stop; whether every part of it was accepted. */
function sendStop(
  context: ServiceContext,
  options: FollowOptions,
  threadId: ThreadId,
  record: RunRecord,
  plan: Exclude<StopPlan, { kind: "wait" | "none" }>,
  stopId: CommandId,
  sent: CommandId[],
): boolean {
  const { store, services } = context;
  const handle = services.engine?.internalHandler ?? services.handler;
  if (!handle) throw new Error("engine_unavailable");
  const send = (id: CommandId, payload: CommandPayload) => {
    sent.push(id);
    const command = Command.parse({ id, deviceId: options.deviceId, payload });
    return store.recordCommand(command.id, command.deviceId, () =>
      handle.handle(command, commandContext(store)),
    );
  };
  switch (plan.kind) {
    case "remove": {
      const queue = services.engine?.queue(threadId);
      if (!queue || !record.inputCommand) return false;
      return send(stopId, {
        type: "queue.remove",
        threadId,
        expectedRevision: queue.revision,
        messageId: record.inputCommand,
      }).ok;
    }
    case "interrupt":
      sent.push(stopId);
      return hostInterrupt(context, options, threadId, stopId, { runId: plan.runId });
    case "stop-work": {
      const part = (name: string) =>
        CommandId.parse(
          `automation-stop-${createHash("sha256").update(`${stopId}:${name}`).digest("hex")}`,
        );
      const results = [
        ...plan.tasks.map(
          (taskId) =>
            send(part(`task:${taskId}`), {
              type: "background_task.stop",
              taskId: BackgroundTaskId.parse(taskId),
            }).ok,
        ),
        ...plan.agentRuns.map((run) => {
          const id = part(`run:${run.runId}`);
          sent.push(id);
          return hostInterrupt(context, options, threadId, id, run);
        }),
      ];
      if (plan.children.length || plan.reservations.length) {
        const host = options.hostStop();
        results.push(
          host
            ? host.cancel(plan.children, plan.reservations, stopId)
            : plan.children
                .map(
                  (child) =>
                    send(part(`child:${child}`), {
                      type: "thread.interrupt",
                      threadId: child,
                      cascade: true,
                    }).ok,
                )
                .every(Boolean),
        );
      }
      return results.every(Boolean);
    }
  }
}

/**
 * Stop one run of the thread, root (`runId` alone) or a native subagent's (`agentId` too). The
 * run's id guards the stop when it is admitted and again when it is delivered. The automation's
 * own stop leaves no Stop marker, so its later runs aren't held.
 */
function hostInterrupt(
  context: ServiceContext,
  options: FollowOptions,
  threadId: ThreadId,
  id: CommandId,
  target: { runId: string; agentId?: string },
): boolean {
  const { store, services } = context;
  const handle = services.engine?.internalHandler ?? services.handler;
  if (!handle) throw new Error("engine_unavailable");
  const command = Command.parse({
    id,
    deviceId: options.deviceId,
    payload: { type: "thread.interrupt", threadId, cascade: true, ...target },
  });
  const host = options.hostStop();
  return host
    ? host.stop(threadId, command).ok
    : store.recordCommand(command.id, command.deviceId, () =>
        handle.handle(command, commandContext(store)),
      ).ok;
}
