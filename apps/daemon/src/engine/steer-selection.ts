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
  if (p.delivery === "steer" && !steerLostRun(repo, id, runId)) return command;
  return Command.parse({
    ...command,
    payload: { ...payload, ...(p.delivery === undefined ? {} : { delivery: "queue" }) },
  });
}

/** Whether the root run a steer names is no longer the thread's active root run. */
export function steerLostRun(repo: EngineRepository, id: ThreadId, runId: string): boolean {
  const state = repo.requireState(id);
  return !(
    state.agents[state.rootKey ?? ""]?.activeRun === runId && state.runs[runId]?.state === "active"
  );
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
