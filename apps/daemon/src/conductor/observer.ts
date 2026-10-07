import { logError } from "@ace/diagnostics";
import { nextDeadline } from "@ace/conductor";
import { Command, type Event, ThreadId } from "@ace/protocol";
import type { ServiceContext } from "../services/types.ts";
import type { ConductorRuntime } from "../conductor-runtime.ts";
import { systemClock } from "../engine/actor.ts";
import type { NativeConductorExecutor } from "./executor.ts";
import type { LaneBinding } from "./journal.ts";
import { parseLaneArtifact } from "./artifacts.ts";
import { readArtifactText } from "./artifact-text.ts";

/** Engine events drive facts. One timer owns deadlines and retries, never client polling. */
export class DeckObserver {
  private context: ServiceContext;
  private runtime: ConductorRuntime;
  private executor: NativeConductorExecutor;
  private stop: (() => void) | undefined;
  private cancelTimer: (() => void) | undefined;
  private tasks = new Set<Promise<void>>();
  private running = new Set<string>();
  private pending = new Map<string, boolean>();
  private owners = new Map<ThreadId, LaneBinding>();
  private activity = new Map<ThreadId, number>();
  private started = false;
  private closed = false;
  constructor(
    context: ServiceContext,
    runtime: ConductorRuntime,
    executor: NativeConductorExecutor,
  ) {
    this.context = context;
    this.runtime = runtime;
    this.executor = executor;
  }
  async start() {
    if (this.closed) return;
    await this.context.services.engine?.ready();
    if (this.closed) return;
    this.started = true;
    // Resume only interrupted in-flight work. Engine recovery retains history and uncertain queues.
    for (const run of this.runtime.active()) {
      const state = this.runtime.state(run);
      if (state) {
        this.executor.restoreOwnership(state);
        this.executor.restoreGates(state);
      }
      if (!state || state.phase === "paused" || state.phase === "cancelling") continue;
      for (const binding of this.executor.journal.current(state)) {
        if (!state.lanes[binding.lane]?.live || state.lanes[binding.lane]?.status === "migrating")
          continue;
        const threads = [
          binding.thread,
          ...this.executor.delegations.journal
            .family(this.executor.journal.root(run)?.thread ?? binding.thread)
            .filter((edge) =>
              this.executor.delegations.journal.isDescendant(edge.childId, binding.thread),
            )
            .map((edge) => edge.childId),
        ];
        for (const threadId of threads.toReversed()) {
          const thread = this.context.store.getThread(threadId);
          if (!thread || !["failed", "waiting", "done"].includes(thread.status.state)) continue;
          const engine = this.context.services.engine;
          const queue = engine?.queuePage({ threadId });
          if (!engine || !queue || queue.reason !== "restart") continue;
          const command = Command.parse({
            id: `restart.${this.context.id()}`,
            deviceId: "ace-conductor",
            payload: { type: "thread.resume", threadId, expectedRevision: queue.revision },
          });
          await engine.prepareCommand(command);
          const result = this.executor.delegations.command(command.id, command.payload);
          if (!result.ok)
            this.context.log.log(
              "warn",
              "Deck recovery requires human input",
              logError(result.error),
            );
        }
      }
    }
    this.stop = this.context.store.subscribe((events) => this.observe(events));
    this.runtime.start();
    for (const run of this.runtime.active()) this.changed(run);
    this.arm();
  }
  changed(run: string, publish = true) {
    if (!this.started || this.closed) return;
    this.pending.set(run, (this.pending.get(run) ?? false) || publish);
    if (this.running.has(run)) return;
    this.running.add(run);
    queueMicrotask(() => {
      const notify = this.pending.get(run) ?? false;
      this.pending.delete(run);
      if (this.closed) {
        this.running.delete(run);
        return;
      }
      const task = this.reconcile(run, notify)
        .catch((error) =>
          this.context.log.log("error", "Deck reconciliation failed", logError(error)),
        )
        .finally(() => {
          this.tasks.delete(task);
          this.running.delete(run);
          if (this.pending.has(run)) this.changed(run, this.pending.get(run));
        });
      this.tasks.add(task);
    });
  }
  private observe(events: readonly Event[]) {
    const runs = new Set<string>();
    for (const event of events) {
      if (event.payload.type === "item.delta") {
        const owner = this.owner(event.threadId);
        if (owner) this.noteActivity(owner.thread, event.at);
        continue;
      }
      if (
        ![
          "thread.updated",
          "thread.client.updated",
          "interaction.opened",
          "interaction.closed",
          "item.created",
          "item.updated",
          "agent.created",
        ].includes(event.payload.type)
      )
        continue;
      const owner = this.owner(event.threadId);
      if (owner) {
        runs.add(owner.run);
        this.noteActivity(owner.thread, event.at);
      }
    }
    for (const run of runs) this.changed(run);
  }
  private noteActivity(thread: ThreadId, at: number) {
    if (this.activity.size >= 128 && !this.activity.has(thread)) {
      const first = this.activity.keys().next().value;
      if (first) this.activity.delete(first);
    }
    this.activity.set(thread, at);
  }
  private owner(threadId: ThreadId): LaneBinding | undefined {
    const known = this.owners.get(threadId);
    if (known) return known;
    let thread: ThreadId | undefined = threadId;
    for (let depth = 0; thread && depth < 9; depth++) {
      const binding = this.executor.journal.forThread(thread);
      if (binding) {
        if (this.owners.size >= 128) {
          const first = this.owners.keys().next().value;
          if (first) this.owners.delete(first);
        }
        this.owners.set(threadId, binding);
        return binding;
      }
      thread = this.executor.delegations.journal.get(thread)?.parentId;
    }
    return undefined;
  }
  private async reconcile(run: string, publish: boolean) {
    await this.context.store.writable();
    let state = this.runtime.state(run);
    if (!state) return;
    if (["done", "cancelled"].includes(state.phase)) {
      this.runtime.retry(run);
      return;
    }
    for (const binding of this.executor.journal.current(state)) {
      state = this.runtime.state(run);
      const lane = state?.lanes[binding.lane];
      if (!state || !lane?.live || lane.generation !== binding.generation) continue;
      const thread = this.context.store.getThread(binding.thread);
      if (!thread) continue;
      if (!lane.artifact && thread.status.state === "done" && !lane.retiring) {
        try {
          const page = this.context.store.readItemPage(
            thread.id,
            this.context.store.headSeq() + 1,
            100,
            1_048_576,
          );
          const message = page.items.findLast(
            (item) => item.type === "message" && item.role === "assistant" && item.complete,
          );
          if (message?.type === "message") {
            const text = readArtifactText(this.context.store, message);
            let artifact = text === undefined ? undefined : parseLaneArtifact(text, lane.role);
            if (artifact) {
              if (artifact.kind === "completion") {
                const head = await this.executor.worktrees.git.resolveCommit({
                  worktree: binding.path,
                  ref: "HEAD",
                });
                if (
                  head !== artifact.completion.revision ||
                  artifact.completion.branch !== binding.branch
                )
                  artifact = undefined;
              }
              if (artifact && this.context.store.getThread(thread.id)?.status.state === "done") {
                try {
                  this.runtime.fact(run, `artifact.${binding.request}.${binding.generation}`, {
                    type: "artifact",
                    laneId: lane.id,
                    generation: lane.generation,
                    artifact,
                  });
                } catch (error) {
                  // Invalid review revision/evidence or plan ownership stays in the transcript.
                  // Still observe done so the missing-artifact deadline can escalate it.
                  this.context.log.log(
                    "warn",
                    "Deck artifact requires correction",
                    logError(error),
                  );
                }
              }
            }
          }
        } catch (error) {
          // Lost streams/worktrees invalidate only the artifact, never status or deadlines.
          this.context.log.log("warn", "Deck artifact unavailable", logError(error));
        }
      }
      state = this.runtime.state(run);
      const current = state?.lanes[lane.id];
      if (!current?.live) continue;
      const observed = this.context.store.getThread(binding.thread);
      if (!observed) continue;
      if (observed.status.state === "limited") {
        if (current.status !== "limited" && current.status !== "migrating")
          this.runtime.fact(run, this.context.id(), {
            type: "usage_limit",
            laneId: lane.id,
            generation: lane.generation,
          });
        continue;
      }
      const status =
        observed.status.state === "needs_you" ||
        observed.status.state === "waiting" ||
        (state?.phase === "paused" && !current.artifact)
          ? "waiting"
          : observed.status.state === "done"
            ? "done"
            : observed.status.state === "failed"
              ? "failed"
              : observed.status.state === "unresponsive"
                ? "unresponsive"
                : "working";
      const activityAt = this.activity.get(binding.thread) ?? current.lastActivity;
      if (current.status !== status || (status === "working" && activityAt > current.lastActivity))
        this.runtime.fact(run, this.context.id(), {
          type: "status",
          laneId: lane.id,
          generation: lane.generation,
          status,
          at: this.context.now(),
        });
      if (status === "done" || status === "failed") this.activity.delete(binding.thread);
    }
    state = this.runtime.state(run);
    if (state && !["done", "cancelled"].includes(state.phase)) {
      const accounts = this.executor.accounts(state.spec, run);
      if (JSON.stringify(accounts) !== JSON.stringify(state.accounts))
        this.runtime.fact(run, this.context.id(), { type: "accounts", accounts });
      const deadline = nextDeadline(state);
      if (deadline !== null && deadline <= this.context.now())
        this.runtime.fact(run, this.context.id(), { type: "tick" });
    }
    if (publish) this.runtime.refresh(run);
    else this.runtime.retry(run);
  }
  private arm() {
    if (this.closed) return;
    const clock = this.context.options.engine?.clock ?? { ...systemClock, now: this.context.now };
    this.cancelTimer = clock.setTimer(() => {
      this.cancelTimer = undefined;
      try {
        for (const run of this.runtime.active()) this.changed(run, false);
      } catch (error) {
        try {
          this.context.options.engine?.onError?.(error);
        } catch {
          /* Reporting cannot stop the next deadline pass. */
        }
      } finally {
        this.arm();
      }
    }, 1000);
  }
  stopAdmission() {
    this.closed = true;
    this.stop?.();
    this.cancelTimer?.();
    this.pending.clear();
    this.activity.clear();
    this.owners.clear();
  }
  async flush() {
    // changed() reserves a running slot before scheduling its microtask.
    while (this.running.size) {
      await Promise.resolve();
      await Promise.allSettled(this.tasks);
    }
  }
  async close() {
    this.stopAdmission();
    await Promise.allSettled(this.tasks);
  }
}
