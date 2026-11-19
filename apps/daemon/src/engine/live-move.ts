import { apply, deriveThreadStatus } from "@ace/core";
import type { Command, CommandResult, ThreadId, ThreadStatus } from "@ace/protocol";
import type { EngineRepository } from "./repository.ts";
import { stoppableTasks } from "./stop-scope.ts";

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

/**
 * Whether the thread, with its whole tree, reads at rest by the normal status rules once the
 * background row `task` (the move's own hold) is set aside: nothing working, waiting on the
 * person or held running in the background, its subagents included through their summary
 * agents. Read on a copy, through core's own reducer; the thread itself is untouched.
 */
export function atRest(repo: EngineRepository, id: ThreadId, task: string, now: number): boolean {
  const state = repo.state(id);
  if (!state) return true;
  // A plain copy, as the state is persisted: read here and dropped, never stored.
  const copy = JSON.parse(JSON.stringify(state)) as typeof state;
  let seq = 0;
  if (copy.tasks[task]?.status === "running")
    apply(
      copy,
      { type: "background.ended", task, status: "completed" },
      {
        now,
        ids: { next: (kind) => `rest-${kind}-${++seq}` },
      },
    );
  return ["done", "new", "failed"].includes(deriveThreadStatus(copy).state);
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

/** What a whole-thread Stop stops that still runs (`stoppableTasks`), by title. */
export function runningShells(repo: EngineRepository, id: ThreadId): string[] {
  const state = repo.state(id);
  if (!state) return [];
  return stoppableTasks(state)
    .map((key) => (state.tasks[key]?.title ?? key).slice(0, 256))
    .slice(0, 32);
}

/** The engine's live-move surface (ADR 0191), bound to its repository and clock. */
export function api(
  repo: () => EngineRepository,
  now: () => number,
  host: { released(id: ThreadId): void },
) {
  return {
    atRest: (id: ThreadId, task: string) => atRest(repo(), id, task, now()),
    markMoved: (id: ThreadId, to: Parameters<typeof markMoved>[2]) =>
      markMoved(repo(), id, to, now()),
    adoptSession: (id: ThreadId, session: Parameters<typeof adoptCarriedSession>[2]) =>
      adoptCarriedSession(repo(), id, session),
    dropSession: (id: ThreadId) => dropCarriedSession(repo(), id),
    shells: (id: ThreadId) => runningShells(repo(), id),
    released: host.released,
  };
}
