import { Command, CommandId, type ExecutionSelection, type ThreadId } from "@ace/protocol";
import { hasNextTurnSelection } from "./input-delivery.ts";
import type { EngineRepository } from "./repository.ts";
import { recordSwitch, resolveSwitch } from "./switch-admission.ts";

/** A send ready to admit, and the pending switch split off it, if any. */
export interface SteerAdmission {
  send: Command;
  selection?: { command: Command; selection: ExecutionSelection };
}

/**
 * A steer aimed at one root run (`runId`) joins only that run. Checked on the send as admitted,
 * after its default delivery is resolved (an omitted delivery may become the configured steer):
 * once that run has ended, or another has begun (the sender was offline and its outbox replays
 * now), the message queues instead, starting the next turn when nothing runs. A steer still
 * aimed at the running turn keeps its run, so delivery checks it again just before the provider
 * reads it (`steerLostRun`); anything else drops it.
 */
export function fenceSteer(repo: EngineRepository, command: Command, id: ThreadId): Command {
  const p = command.payload;
  if (p.type !== "thread.send" || p.runId === undefined) return command;
  const { runId, ...payload } = p;
  // Resolved delivery: the daemon's default may have made this a steer the sender never asked for.
  if (p.delivery === "steer" && !steerLostRun(repo, id, runId)) return command;
  return Command.parse({
    ...command,
    payload: { ...payload, ...(p.delivery === undefined ? {} : { delivery: "queue" }) },
  });
}

/**
 * Aims a fresh steer at the turn running as the person sends it (or at nothing, `null`, when no
 * turn runs). That turn is the one the person meant to steer into: once it ends, the message
 * queues as the next one instead of cancelling a later turn they never saw.
 */
export function aimSteerAtRun(repo: EngineRepository, command: Command, id: ThreadId): Command {
  const p = command.payload;
  if (p.type !== "thread.send" || p.delivery !== "steer" || p.runId !== undefined) return command;
  return aimAtActiveRun(repo, command, id);
}

/**
 * Aims a waiting message the person chooses to steer in at the turn running now, replacing any
 * target it kept: one that has already ended would bounce it straight back to the queue.
 */
export function reaimSteerAtRun(repo: EngineRepository, command: Command, id: ThreadId): Command {
  const p = command.payload;
  if (p.type !== "thread.send" || p.delivery !== "steer") return command;
  return aimAtActiveRun(repo, command, id);
}

/**
 * Aims a steer at the turn an active run names, or at `null` when none runs. Only a session that
 * steers by cancelling the running turn (ACP) is aimed: every other provider steers natively and
 * reads no run, and a run it named would fence a steer it never asked for.
 */
function aimAtActiveRun(repo: EngineRepository, command: Command, id: ThreadId): Command {
  const p = command.payload;
  if (p.type !== "thread.send" || !repo.steersByCancel?.(id)) return command;
  const state = repo.state(id);
  if (!state) return command;
  return Command.parse({ ...command, payload: { ...p, runId: activeRootRun(repo, id) } });
}

/** The root's running turn, or `null` while the thread sits between turns. */
export function activeRootRun(repo: EngineRepository, id: ThreadId): string | null {
  const state = repo.state(id);
  return state?.agents[state.rootKey ?? ""]?.activeRun ?? null;
}

/**
 * Records the turn an admitted steer went into, beside its payload rather than in it: a payload
 * `runId` fences every steer that carries one, so only a live cancel-steered session is stamped.
 * The lane's cancel path reads this aim where a session that steers by cancelling has no payload
 * target, such as a steer sent while the session is still opening.
 */
export function recordSteerAim(
  repo: EngineRepository,
  intent: number,
  id: ThreadId,
  command: Command,
): void {
  const p = command.payload;
  if (p.type !== "thread.send" || p.delivery !== "steer") return;
  repo.steerAims.record(intent, activeRootRun(repo, id));
}

/**
 * Whether what a steer's sender saw no longer holds: the root run it named isn't the active one,
 * or (`null`, it saw none) a root run is active now.
 */
export function steerLostRun(repo: EngineRepository, id: ThreadId, runId: string | null): boolean {
  const state = repo.requireState(id);
  const active = state.agents[state.rootKey ?? ""]?.activeRun;
  if (runId === null) return active !== undefined;
  return !(active === runId && state.runs[runId]?.state === "active");
}

/**
 * A person's steer always steers. A model or options change on it can't apply inside the work
 * that is running: switching may reconfigure or reopen the session. So while the tree works, the
 * text steers now and the change becomes the thread's pending `thread.switch`, applied at the
 * next whole-tree boundary. With nothing running the change belongs to the turn this message
 * starts, so the send keeps it. A provider that can't steer queues the send with its selection.
 */
export function admitSteer(repo: EngineRepository, command: Command, id: ThreadId): SteerAdmission {
  const p = command.payload;
  if (p.type !== "thread.send" || p.delivery !== "steer" || !hasNextTurnSelection(p))
    return { send: command };
  const thread = repo.store.getThread(id);
  const capabilities = thread?.effectiveCapabilities ?? thread?.capabilities;
  // A switch already waiting for the boundary is what the thread will run on: build on it, so a
  // new effort never drops a model or account the person picked before.
  const queued = thread?.switch?.state === "queued" ? thread.switch.selection : undefined;
  const current = queued ??
    repo.transitions.get(id).selection ?? {
      provider: repo.requireState(id).config.provider,
      options: {},
      ...repo.session(id),
    };
  const selection =
    capabilities?.steer && !repo.quiescent(repo.requireState(id)) && repo.reserve(id)
      ? resolveSwitch(
          repo,
          id,
          {
            provider: current.provider,
            ...(current.instanceId ? { instanceId: current.instanceId } : {}),
            model: p.model ?? current.model,
            ...(p.options === undefined ? {} : { options: p.options }),
          },
          () => capabilities,
        )
      : undefined;
  if (selection === undefined || typeof selection === "string")
    return { send: Command.parse({ ...command, payload: { ...p, delivery: "queue" } }) };
  const { model: _model, options: _options, ...text } = p;
  return {
    send: Command.parse({ ...command, payload: text }),
    selection: {
      selection,
      command: Command.parse({
        id: CommandId.parse(`${command.id}:selection`),
        deviceId: command.deviceId,
        payload: { type: "thread.switch", threadId: id, selection },
      }),
    },
  };
}

/** Queues the switch split off an admitted steer, ordered right behind that steer. */
export function queueSteerSelection(
  repo: EngineRepository,
  id: ThreadId,
  admission: SteerAdmission,
  at: number,
): void {
  if (!admission.selection) return;
  recordSwitch(repo, id, admission.selection.selection, at);
  repo.add(admission.selection.command, id);
  repo.pending.placeAfter(id, admission.selection.command.id, admission.send.id);
}
