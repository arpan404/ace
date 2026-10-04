import type { Command, CommandId, ThreadId } from "@ace/protocol";
import type { EngineRepository } from "./repository.ts";
import { provisionalTitle } from "./thread-title.ts";
import { inputOrigin } from "./input-journal.ts";

export function syntheticInput(repo: EngineRepository,

    id: ThreadId,
    key: string,
    text: string,
    origin: import("@ace/protocol").MessageOrigin,
    at: number,
  ): void {
    const parts = [{ type: "text" as const, text }];
    repo.inputs.register(id, key, parts, origin);
    repo.inputs.sending(id, key, parts);
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

export function admitInput(repo: EngineRepository, command: Command, id: ThreadId, at: number): void {
    const p = command.payload;
    if (p.type !== "thread.create" && p.type !== "thread.send") return;
    const thread = repo.store.getThread(id);
    if (thread?.titleSource === "provisional" && thread.title === "New thread")
      repo.store.appendEvents(
        id,
        [{ type: "thread.updated", title: provisionalTitle(p.input), titleSource: "provisional" }],
        at,
      );
    const key = `input:${command.id}`;
    const origin = inputOrigin(command);
    repo.inputs.register(id, key, p.input, origin);
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

export function removeInput(repo: EngineRepository, id: ThreadId, commandId: CommandId, at: number): void {
    const state = repo.requireState(id);
    const key = `input:${commandId}`;
    repo.inputs.invalidate(id, key);
    const item = state.items[key];
    if (!item) return;
    delete state.items[key];
    repo.save(state, [{ type: "item.deleted", itemId: item.id }], at);
  }

