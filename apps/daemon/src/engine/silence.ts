import { SettingsValues, ThreadId, type Command, type WorkspaceId } from "@ace/protocol";
import type { ThreadActor } from "./actor.ts";
import type { EngineRepository } from "./repository.ts";

const UnresponsiveAfter = SettingsValues.shape["threads.unresponsiveAfter"];
export type UnresponsiveAfter = import("zod").infer<typeof UnresponsiveAfter>;

const unresponsiveAfterDurations: Readonly<Record<UnresponsiveAfter, number>> = {
  "2m": 2 * 60_000,
  "5m": 5 * 60_000,
  "15m": 15 * 60_000,
};

/** Matches `packages/settings` default (`threads.unresponsiveAfter = "5m"`). */
export const defaultSilenceMs = unresponsiveAfterDurations["5m"];

export function unresponsiveAfterMs(value: UnresponsiveAfter): number {
  return unresponsiveAfterDurations[value];
}

export function parseSilenceMs(value: unknown, fallback = defaultSilenceMs): number {
  const parsed = UnresponsiveAfter.safeParse(value);
  return parsed.success ? unresponsiveAfterDurations[parsed.data] : fallback;
}

export function validSilenceMs(ms: number): number {
  if (!Number.isSafeInteger(ms) || ms < 0) throw new Error("Invalid silenceMs");
  return ms;
}

export type SilenceResolver = (scope: {
  threadId?: ThreadId;
  workspaceId?: WorkspaceId;
}) => Promise<number | undefined>;

/**
 * Resolves and applies `threads.unresponsiveAfter` across new, recovered and live threads.
 * Explicit `options.silenceMs` without a resolver stays fixed (used by deterministic engine tests).
 */
export class SilenceThresholds {
  private defaultMs: number;
  private workspaceMs = new Map<WorkspaceId, number>();
  private resolve: SilenceResolver | undefined;
  private workspaceOf: (id: ThreadId) => WorkspaceId | undefined;
  constructor(
    initialMs: number | undefined,
    resolve: SilenceResolver | undefined,
    workspaceOf: (id: ThreadId) => WorkspaceId | undefined,
  ) {
    this.defaultMs = validSilenceMs(initialMs ?? defaultSilenceMs);
    this.resolve = resolve;
    this.workspaceOf = workspaceOf;
  }
  forWorkspace(workspaceId?: WorkspaceId): number {
    return (workspaceId ? this.workspaceMs.get(workspaceId) : undefined) ?? this.defaultMs;
  }
  setDefault(ms: number): void {
    this.defaultMs = validSilenceMs(ms);
    this.workspaceMs.clear();
  }
  clearWorkspace(workspaceId?: WorkspaceId): void {
    if (workspaceId === undefined) this.workspaceMs.clear();
    else this.workspaceMs.delete(workspaceId);
  }
  async prepareGlobal(): Promise<void> {
    if (!this.resolve) return;
    const resolved = await this.resolve({});
    if (resolved !== undefined) this.setDefault(resolved);
  }
  async prepareWorkspace(workspaceId: WorkspaceId): Promise<void> {
    if (!this.resolve) return;
    const resolved = await this.resolve({ workspaceId });
    if (resolved !== undefined) this.workspaceMs.set(workspaceId, validSilenceMs(resolved));
  }
  async syncThread(id: ThreadId, apply: (id: ThreadId, ms: number) => void): Promise<void> {
    if (!this.resolve) return;
    const workspaceId = this.workspaceOf(id);
    const resolved = await this.resolve({
      threadId: id,
      ...(workspaceId === undefined ? {} : { workspaceId }),
    });
    if (resolved !== undefined) apply(id, validSilenceMs(resolved));
  }
  async prepareCommand(command: Command, apply: (id: ThreadId, ms: number) => void): Promise<void> {
    if (!this.resolve) return;
    const p = command.payload;
    if (p.type === "thread.create" || p.type === "thread.prepare") {
      await this.prepareWorkspace(p.workspaceId);
    } else if (
      "threadId" in p &&
      p.threadId &&
      ["thread.send", "thread.resume", "queue.resume", "thread.limit", "thread.fork"].includes(
        p.type,
      )
    ) {
      await this.syncThread(ThreadId.parse(p.threadId), apply);
    }
  }
  applyThread(
    repo: EngineRepository,
    actor: ThreadActor | undefined,
    id: ThreadId,
    ms: number,
    now: () => number,
    wake: (id: ThreadId) => void,
  ): void {
    const next = validSilenceMs(ms);
    if (actor) {
      actor.enqueue(() => {
        const state = repo.state(id);
        if (!state || state.config.silenceMs === next) return;
        const materialized = state.rootKey !== undefined;
        repo.setSilenceMs(id, next, now());
        if (materialized) {
          actor.apply([{ type: "tick" }]);
          wake(id);
        } else {
          actor.schedule();
        }
      });
      return;
    }
    repo.setSilenceMs(id, next, now());
  }
}
