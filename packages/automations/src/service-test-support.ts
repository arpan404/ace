import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach } from "vitest";
import {
  AutomationService,
  AutomationStore,
  type ExecutionInput,
  type ExecutionResult,
  type TimerDriver,
  type WorkspaceChanges,
} from "./index.ts";
import type { Automation, AutomationEvent } from "@ace/protocol";
export const start = Date.parse("2024-01-01T09:00:00Z");
export const definition = (patch: Partial<Automation> = {}): Automation => ({
  id: "triage",
  title: "Triage",
  enabled: true,
  workspace: "/project",
  provider: "codex",
  model: "test-model",
  prompt: "Triage {{subject}}",
  worktree: true,
  trigger: { kind: "manual" },
  missedRun: "skip",
  concurrency: 1,
  jitterMs: 0,
  ...patch,
});
export const scheduled = (policy: Automation["missedRun"] = "skip", jitterMs = 0) =>
  definition({
    prompt: "Triage {{scheduled_at}}",
    trigger: {
      kind: "schedule",
      schedule: { kind: "rrule", expression: "FREQ=DAILY", timezone: "UTC", startAt: start },
    },
    missedRun: policy,
    jitterMs,
  });
function uninitialized(): never {
  throw new Error("Not initialized");
}
export function deferred<T>() {
  let resolve: (value: T) => void = uninitialized;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
class Timer implements TimerDriver {
  active = new Map<number, { delay: number; callback: () => void | Promise<void> }>();
  private id = 0;
  maximum = 0;
  arm(delay: number, callback: () => void | Promise<void>): () => void {
    const id = ++this.id;
    this.active.set(id, { delay, callback });
    this.maximum = Math.max(this.maximum, this.active.size);
    return () => {
      this.active.delete(id);
    };
  }
  async fire(): Promise<void> {
    const entry = this.active.entries().next().value;
    if (!entry) throw new Error("No timer");
    this.active.delete(entry[0]);
    await entry[1].callback();
  }
  get delay() {
    return this.active.values().next().value?.delay;
  }
}
const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const dispose of cleanup.splice(0).toReversed()) dispose();
});
export function harness() {
  const dir = mkdtempSync(join(tmpdir(), "ace-automations-"));
  let store = new AutomationStore(join(dir, "auto.sqlite"));
  let now = start - 60_000;
  let ids = 0;
  let random = 0;
  const timer = new Timer(),
    inputs: ExecutionInput[] = [],
    completions: ReturnType<typeof deferred<ExecutionResult>>[] = [],
    errors: unknown[] = [];
  const changes: import("@ace/protocol").AutomationRun[] = [];
  const watches = new Map<string, (event: AutomationEvent) => Promise<void>>();
  const workspace: WorkspaceChanges = {
    subscribe(path, _paths, receive) {
      watches.set(path, receive);
      return () => {
        watches.delete(path);
      };
    },
  };
  const recoveries = new Map<string, Promise<ExecutionResult | undefined>>();
  const deps = {
    now: () => now,
    random: () => random,
    id: () => `run-${++ids}`,
    timer,
    workspace,
    onRun: (run: import("@ace/protocol").AutomationRun) => {
      changes.push(run);
    },
    onError: (e: unknown) => {
      errors.push(e);
    },
    executor: {
      execute(input: ExecutionInput) {
        inputs.push(input);
        const completion = deferred<ExecutionResult>();
        completions.push(completion);
        return completion.promise;
      },
      recover(key: string) {
        return recoveries.get(key) ?? Promise.resolve(undefined);
      },
    },
  };
  let service = new AutomationService(store, deps);
  service.start();
  cleanup.push(() => {
    service.stop();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return {
    get service() {
      return service;
    },
    get store() {
      return store;
    },
    timer,
    inputs,
    completions,
    errors,
    watches,
    changes,
    recoveries,
    set now(value: number) {
      now = value;
    },
    set random(value: number) {
      random = value;
    },
    restart() {
      service.stop();
      store.close();
      store = new AutomationStore(join(dir, "auto.sqlite"));
      service = new AutomationService(store, deps);
      service.start();
    },
    async finish(index = 0, status: ExecutionResult["status"] = "succeeded") {
      completions[index]?.resolve({
        threadId: `thread-${index}`,
        status,
        result: "Reviewed three issues",
      });
      await service.settled();
    },
  };
}
