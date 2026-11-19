import type { Command, CommandResult, ThreadId, ThreadStatus } from "@ace/protocol";
import type { EngineRepository } from "./repository.ts";

/*
 * What the engine does for a thread moving to another machine while it works (ADR 0191): the
 * facts the safe point reads, the fence that refuses new turns, the moved state, and the carried
 * native session a new thread there continues.
 */

/** Commands that would start or redirect a turn; a moving or moved thread refuses them. */
const turnCommands = new Set([
  "thread.send",
  "thread.resume",
  "queue.resume",
  "thread.switch",
  "thread.limit",
  "thread.move",
  "thread.continueOn",
]);

/** The fence's answer to one command, or none when it may run. */
export function fenceCommand(
  command: Command,
  refusal: (threadId: ThreadId) => { code: string; detail: string } | undefined,
): CommandResult | undefined {
  const payload = command.payload;
  if (!turnCommands.has(payload.type) || !("threadId" in payload) || !payload.threadId)
    return undefined;
  const refused = refusal(payload.threadId as ThreadId);
  return refused
    ? { commandId: command.id, ok: false, error: refused.code, ...refused }
    : undefined;
}

/** Controls that only take work down: they still run while the thread is fenced. */
const teardown = new Set(["thread.interrupt", "thread.archive"]);

/**
 * The pending controls that may run now. While the thread is fenced only teardown goes; the
 * rest (a goal, a model, a permission change, an answer) waits, so no provider reopens here.
 */
export function admittedControls<T extends { kind: string }>(controls: T[], fenced: boolean): T[] {
  return fenced ? controls.filter((intent) => teardown.has(intent.kind)) : controls;
}

/** Whether a turn runs and what it is in the middle of, for the safe point. */
export function turnFacts(repo: EngineRepository, id: ThreadId) {
  const state = repo.state(id);
  if (!state) return { turnRunning: false, toolsRunning: 0, streaming: 0 };
  // An ace background row (the move's own hold) isn't the agent's turn.
  const inTurn = Object.values(state.agents).some(({ agent: { status } }) =>
    status.state === "blocked" ? status.on !== "background_task" : status.state === "working",
  );
  return {
    turnRunning: inTurn,
    toolsRunning: Object.keys(state.indexes.liveTools).length,
    streaming: Object.keys(state.indexes.openText).length,
  };
}

/** The thread reads moved (or, with null, runs here again). */
export function markMoved(
  repo: EngineRepository,
  id: ThreadId,
  to: Extract<ThreadStatus, { state: "moved" }>["to"] | null,
  now: number,
): void {
  if (repo.state(id)) repo.apply(id, [{ type: "thread.moved", to }], now);
}

/**
 * A new thread continues a session copied into `instanceId`'s home: resumed by id, or forked
 * from its end (ADR 0018's account copy does the same). Set before its first turn opens.
 */
export function adoptCarriedSession(
  repo: EngineRepository,
  id: ThreadId,
  session: { nativeSessionId: string; instanceId: string; action: "resume" | "fork" },
): void {
  repo.store.atomic(() => {
    if (session.action === "resume") {
      repo.nativeSession(id, session.nativeSessionId, undefined, session.instanceId);
      return;
    }
    repo.nativeSession(id, undefined, undefined, session.instanceId);
    const point = { type: "end" as const, nativeId: session.nativeSessionId };
    repo.transitions.set(id, {
      ...repo.transitions.get(id),
      fork: { nativeSessionId: session.nativeSessionId, point },
    });
  });
}

/** The carried session didn't open: the thread starts fresh with its handoff instead. */
export function dropCarriedSession(repo: EngineRepository, id: ThreadId): void {
  repo.store.atomic(() => {
    repo.store
      .statement("UPDATE engine_sessions SET native_session_id=NULL WHERE thread_id=?")
      .run(id);
    const { fork: _fork, ...rest } = repo.transitions.get(id);
    repo.transitions.set(id, rest);
  });
}

/** The agent's own background work still running (shells, monitors), by title. */
export function runningShells(repo: EngineRepository, id: ThreadId): string[] {
  const state = repo.state(id);
  if (!state) return [];
  return Object.values(state.tasks)
    .filter((task) => task.status === "running" && task.owner !== "ace" && !task.internal)
    .map((task) => task.title.slice(0, 256))
    .slice(0, 32);
}
