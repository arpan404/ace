import { ThreadId, Command } from "@ace/protocol";
import type { EngineRepository } from "./repository.ts";

export interface CreationAdmission {
  command: Command;
  owner: object;
  release(): void;
}
/** Reservations span asynchronous preparation and the synchronous receipt transaction. */
export class CreationAdmissions {
  private owners = new Map<ThreadId, { owner: object; command: string }>();
  private repo: EngineRepository;
  private nextId: () => string;
  constructor(repo: EngineRepository, nextId: () => string) {
    this.repo = repo;
    this.nextId = nextId;
  }
  acquire(command: Command): CreationAdmission | string {
    const p = command.payload;
    if (p.type !== "thread.create" && p.type !== "thread.prepare") return "invalid_command";
    const id = p.threadId ?? ThreadId.parse(this.nextId());
    if (this.owners.has(id)) return "thread_creation_in_progress";
    if (this.repo.store.getThread(id)) return "thread_exists";
    if (!this.repo.reserve(id)) return "engine_capacity_exceeded";
    const normalized = Command.parse({ ...command, payload: { ...p, threadId: id } });
    const owner = {};
    this.owners.set(id, { owner, command: JSON.stringify(normalized) });
    return {
      command: normalized,
      owner,
      release: () => {
        if (this.owners.get(id)?.owner !== owner) return;
        this.owners.delete(id);
        if (!this.repo.store.getThread(id)) this.repo.release(id);
      },
    };
  }
  authorized(command: Command, owner: object | undefined): boolean {
    const p = command.payload;
    if (p.type !== "thread.create" && p.type !== "thread.prepare") return false;
    const held = p.threadId ? this.owners.get(p.threadId) : undefined;
    return held
      ? held.owner === owner && held.command === JSON.stringify(command)
      : owner === undefined;
  }
}
