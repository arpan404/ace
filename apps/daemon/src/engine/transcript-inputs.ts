import type { Command, CommandId, EventPayload, RunId, ThreadId } from "@ace/protocol";
import type { ThreadState } from "@ace/core";
import type { EngineRepository } from "./repository.ts";
import { provisionalTitle } from "./thread-title.ts";
import { inputOrigin } from "./input-journal.ts";

export function syntheticInput(
  repo: EngineRepository,

  id: ThreadId,
  key: string,
  text: string,
  origin: import("@ace/protocol").MessageOrigin,
  at: number,
): void {
  const parts = [{ type: "text" as const, text }];
  repo.inputs.register(id, key, parts, origin);
  repo.apply(
    id,
    [
      {
        type: "item.upsert",
        agent: repo.requireState(id).rootKey ?? "root",
        item: key,
        draft: {
          type: "message",
          role: "user",
          parts,
          origin,
          synthetic: true,
          complete: true,
          raw: [],
        },
      },
    ],
    at,
  );
}

/**
 * A send the daemon accepts: it may name the thread, and the journal learns its origin. Its
 * transcript item waits for delivery (`admitInput`), so a message queued behind a run joins the
 * transcript where it leaves the queue, never where it was typed (ADR 0065).
 */
export function acceptInput(
  repo: EngineRepository,
  command: Command,
  id: ThreadId,
  at: number,
): void {
  const p = command.payload;
  if (p.type !== "thread.create" && p.type !== "thread.send") return;
  const key = `input:${command.id}`;
  const origin = repo.inputs.origin(id, key) ?? inputOrigin(command);
  const thread = repo.store.getThread(id);
  if (
    (origin.kind === "person" || origin.kind === "queue") &&
    (thread?.titleSource === "provisional" || !thread?.titleSource) &&
    thread?.title === "New thread"
  )
    repo.store.appendEvents(
      id,
      [{ type: "thread.updated", title: provisionalTitle(p.input), titleSource: "provisional" }],
      at,
    );
  repo.inputs.register(id, key, p.input, origin);
}

/**
 * The engine takes an accepted send out of the queue to deliver it. Its user item is created
 * here, at this point in the thread, and belongs to `run` when the delivery steers into that
 * running turn. Otherwise it has no run until a run consumes it (`bindStartedRun`). An item left
 * by an earlier attempt keeps its place and is bound afresh.
 */
export function admitInput(
  repo: EngineRepository,
  command: Command,
  id: ThreadId,
  run: RunId | undefined,
  at: number,
): void {
  const p = command.payload;
  if (p.type !== "thread.create" && p.type !== "thread.send") return;
  const key = `input:${command.id}`;
  const origin = repo.inputs.origin(id, key) ?? inputOrigin(command);
  repo.inputs.attachRun(id, key, run);
  if (origin.kind === "subagent_result" && repo.aceInputs.get(id, command.id)) return;
  if (!repo.requireState(id).items[key]) upsertInput(repo, command, id, at);
  const state = repo.requireState(id);
  const update = bindItemRun(state, key, run);
  if (update) repo.save(state, [update], at);
}

/** A queued message the person edits: a bubble left by an earlier attempt shows the new text. */
export function reviseInput(
  repo: EngineRepository,
  command: Command,
  id: ThreadId,
  at: number,
): void {
  if (repo.requireState(id).items[`input:${command.id}`]) upsertInput(repo, command, id, at);
}

function upsertInput(repo: EngineRepository, command: Command, id: ThreadId, at: number): void {
  const p = command.payload;
  if (p.type !== "thread.create" && p.type !== "thread.send") return;
  const key = `input:${command.id}`;
  const origin = repo.inputs.origin(id, key) ?? inputOrigin(command);
  repo.apply(
    id,
    [
      {
        type: "item.upsert",
        agent: repo.requireState(id).rootKey ?? "root",
        item: key,
        draft: {
          type: "message",
          role: "user",
          parts: p.input,
          origin,
          synthetic: origin.kind !== "person" && origin.kind !== "queue",
          complete: true,
          raw: [],
        },
      },
    ],
    at,
  );
}

/**
 * A root run started in session `generation`: it consumed every input that session was handed
 * and no run has taken yet (one, or several the provider took as one turn). Each joins the run,
 * so the transcript groups it with the turn answering it.
 */
export function bindStartedRun(
  repo: EngineRepository,
  state: ThreadState,
  run: RunId,
  generation: number | undefined,
): EventPayload[] {
  return repo.inputs.bindSent(state.threadId, run, generation).flatMap((key) => {
    const update = bindItemRun(state, key, run);
    return update ? [update] : [];
  });
}

/**
 * The provider says which run took a delivered input: the root's running turn, or with none
 * running, the next one (`bindStartedRun` binds it when it starts). This corrects a steer that
 * reached the provider just as its turn ended and ran as a new turn. An input that moves off a
 * finished run was never that run's: it is created again here, at the point it was consumed, so
 * it reads before the answer of the run that took it. Only inputs this session was handed move.
 */
export function bindConsumedInput(
  repo: EngineRepository,
  state: ThreadState,
  key: string,
  generation: number | undefined,
  at: number,
): EventPayload[] {
  const item = state.items[key];
  const root = state.agents[state.rootKey ?? ""];
  if (item?.type !== "message" || item.agentId !== root?.agent.id) return [];
  const run = root.activeRun;
  if (item.runId === run || !repo.inputs.sentIn(state.threadId, key, generation)) return [];
  if (item.runId !== undefined && state.runs[item.runId]?.state === "active") return [];
  repo.inputs.attachRun(state.threadId, key, run);
  if (item.runId === undefined) {
    const update = run === undefined ? undefined : bindItemRun(state, key, run);
    return update ? [update] : [];
  }
  const { runId: _previous, ...rest } = item;
  const moved = { ...rest, createdAt: at, ...(run === undefined ? {} : { runId: run }) };
  state.items[key] = moved;
  return [
    { type: "item.deleted", itemId: item.id },
    { type: "item.created", item: moved },
  ];
}

function bindItemRun(
  state: ThreadState,
  key: string,
  run: RunId | undefined,
): EventPayload | undefined {
  const item = state.items[key];
  const root = state.agents[state.rootKey ?? ""]?.agent.id;
  if (item?.type !== "message" || item.agentId !== root || item.runId === run) return undefined;
  const { runId: _previous, ...rest } = item;
  const updated = run === undefined ? rest : { ...rest, runId: run };
  state.items[key] = updated;
  return { type: "item.updated", item: updated };
}

/**
 * The person's message that named the thread hands its text to title generation, once: only
 * while the title is still the provisional one this message produced.
 */
export function notifyNamingPrompt(repo: EngineRepository, command: Command, id: ThreadId): void {
  const p = command.payload;
  if (p.type !== "thread.create" && p.type !== "thread.send") return;
  const origin = repo.inputs.origin(id, `input:${command.id}`) ?? inputOrigin(command);
  if (origin.kind !== "person" && origin.kind !== "queue") return;
  const thread = repo.store.getThread(id);
  if (thread?.titleSource !== "provisional" || thread.title === "New thread") return;
  if (provisionalTitle(p.input) !== thread.title) return;
  repo.onNamingPrompt?.(id, p.input);
}

export function removeInput(
  repo: EngineRepository,
  id: ThreadId,
  commandId: CommandId,
  at: number,
): void {
  const state = repo.requireState(id);
  const key = `input:${commandId}`;
  repo.inputs.invalidate(id, key);
  const item = state.items[key];
  if (!item) return;
  delete state.items[key];
  repo.save(state, [{ type: "item.deleted", itemId: item.id }], at);
}
