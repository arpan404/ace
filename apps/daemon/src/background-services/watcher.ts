import type { Event, ThreadId } from "@ace/protocol";
import type { BackgroundPortsHost } from "../engine/background-ports.ts";
import type { PortProbe } from "./probe.ts";
import { nextProbeDelay, portsChanged } from "./task-ports.ts";

/*
 * Watches background commands left running after their agent's turn and reports the ports
 * their processes listen on (ADR 0109). A thread is watched from the first background shell
 * with an output file until none runs. Probes run one at a time, soon after a change and then
 * backing off to once a minute; a thread with no turn over is not probed.
 */

export interface PortWatcherOptions {
  host: BackgroundPortsHost;
  probe: PortProbe;
  subscribe(listener: (events: readonly Event[]) => void): () => void;
  setTimer(callback: () => void, delay: number): () => void;
  onError?(error: unknown): void;
}

interface Watch {
  probes: number;
  cancel?: () => void;
}

const watchedEvents = new Set(["background_task.started", "agent.status", "thread.updated"]);

export class BackgroundPortWatcher {
  private readonly watched = new Map<ThreadId, Watch>();
  private queue: Promise<void> = Promise.resolve();
  private closed = false;
  private readonly unsubscribe: () => void;
  private readonly options: PortWatcherOptions;

  constructor(options: PortWatcherOptions) {
    this.options = options;
    this.unsubscribe = options.subscribe((events) => {
      const touched = new Set<ThreadId>();
      for (const event of events) {
        const { payload } = event;
        if (!watchedEvents.has(payload.type)) continue;
        const starts =
          payload.type === "background_task.started" &&
          payload.task.kind === "shell" &&
          payload.task.status === "running" &&
          payload.task.outputPath !== undefined;
        if (starts || this.watched.has(event.threadId)) touched.add(event.threadId);
      }
      for (const threadId of touched) this.arm(threadId, true);
    });
  }

  close(): void {
    this.closed = true;
    this.unsubscribe();
    for (const watch of this.watched.values()) watch.cancel?.();
    this.watched.clear();
  }

  private arm(threadId: ThreadId, changed: boolean): void {
    if (this.closed) return;
    const watch = this.watched.get(threadId) ?? { probes: 0 };
    this.watched.set(threadId, watch);
    if (changed) watch.probes = 0;
    watch.cancel?.();
    watch.cancel = this.options.setTimer(() => {
      delete watch.cancel;
      this.queue = this.queue.then(() => this.check(threadId));
    }, nextProbeDelay(watch.probes));
  }

  private async check(threadId: ThreadId): Promise<void> {
    const watch = this.watched.get(threadId);
    if (this.closed || !watch || watch.cancel) return;
    try {
      const candidates = this.options.host.candidates(threadId);
      if (!candidates.length) {
        this.watched.delete(threadId);
        return;
      }
      const due = candidates.filter((candidate) => candidate.turnFinished);
      // Its turn hasn't finished: the turn's end re-arms the watch through its status events.
      if (!due.length) return;
      const ports = await this.options.probe(due.map((candidate) => candidate.outputPath));
      if (this.closed) return;
      let changed = false;
      for (const candidate of due) {
        const now = ports.get(candidate.outputPath);
        if (!now || !portsChanged(candidate.listening, now)) continue;
        changed = true;
        this.options.host.report(threadId, candidate.taskId, now);
      }
      if (!changed) watch.probes++;
    } catch (error) {
      watch.probes++;
      this.options.onError?.(error);
    }
    if (this.watched.get(threadId) === watch && !watch.cancel) this.arm(threadId, false);
  }
}
