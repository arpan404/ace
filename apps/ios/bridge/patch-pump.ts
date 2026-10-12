import { host, scheduler } from "./host.ts";
import { degradedPatch } from "./degraded-patch.ts";

type Reader = () => Record<string, unknown> | undefined;
interface Task {
  key: string;
  read: Reader;
  failures: number;
  readyAt: number;
  degraded: boolean;
  parked: boolean;
  settled: boolean;
}
interface Delivery {
  task: Task;
  read: Reader;
  sticky: boolean;
}
interface Fragment extends Delivery {
  id: string;
  data: string;
  offset: number;
  index: number;
}

function priority(key: string): 0 | 1 | 2 {
  if (key === "inbox:reset" || key === "thread:reset") return 0;
  if (key.startsWith("thread:item:") || key.startsWith("thread:position:")) return 2;
  if (key === "thread:ready" || key === "thread:cursor") return 2;
  return 1; // Canonical status, interactions, connection and command outcomes precede content.
}

/** One acknowledged frame in flight. Queues hold readers, never transcript copies. */
export class PatchPump {
  #inFlight: { delivered: Delivery[]; commit: () => void } | undefined;
  #timer: { cancel: () => void; at: number } | undefined;
  #queues: [Map<string, Task>, Map<string, Task>, Map<string, Task>] = [
    new Map(),
    new Map(),
    new Map(),
  ];
  #fragment: Fragment | undefined;

  put(key: string, read: Reader): void {
    const queue = this.#queue(key);
    const existing = queue.get(key);
    if (existing) {
      existing.read = read;
      existing.settled = false;
      // A quarantined identity gets one degraded retry when its canonical data changes.
      if (existing.parked) {
        existing.parked = false;
        existing.readyAt = host.now() + 1000;
      }
    } else
      queue.set(key, {
        key,
        read,
        failures: 0,
        readyAt: 0,
        degraded: false,
        parked: false,
        settled: false,
      });
    this.#schedule();
  }
  ack(accepted: boolean): void {
    const delivery = this.#inFlight;
    if (!delivery) return;
    this.#inFlight = undefined;
    if (accepted) delivery.commit();
    else {
      this.#fragment = undefined; // Native discarded its incomplete assembly.
      for (const entry of delivery.delivered) this.#reject(entry);
    }
    this.#schedule();
  }
  clear(prefix: string): void {
    for (const queue of this.#queues)
      for (const key of queue.keys()) if (key.startsWith(prefix)) queue.delete(key);
    this.#schedule();
  }
  #queue(key: string): Map<string, Task> {
    return this.#queues[priority(key)];
  }
  #blocked(task: Task): boolean {
    // A delayed reset must not erase already-confirmed rows from its own scope.
    return (
      (task.key !== "inbox:reset" &&
        task.key.startsWith("inbox:") &&
        this.#queue("inbox:reset").has("inbox:reset")) ||
      (task.key !== "thread:reset" &&
        task.key.startsWith("thread:") &&
        this.#queue("thread:reset").has("thread:reset"))
    );
  }
  #schedule(): void {
    if (this.#inFlight) return;
    const now = host.now();
    let next = this.#fragment ? now : Infinity;
    for (const queue of this.#queues) {
      for (const task of queue.values()) {
        if (!task.parked && !task.settled && !this.#blocked(task))
          next = Math.min(next, task.readyAt);
        if (next <= now) break;
      }
      if (next <= now) break;
    }
    if (next === Infinity) {
      this.#timer?.cancel();
      this.#timer = undefined;
      return;
    }
    const at = Math.max(now + 8, next);
    if (this.#timer && this.#timer.at <= at) return;
    this.#timer?.cancel();
    this.#timer = {
      at,
      cancel: scheduler.set(at - now, () => {
        this.#timer = undefined;
        this.#flush();
      }),
    };
  }
  #flush(): void {
    if (this.#inFlight) return;
    if (this.#fragment) {
      this.#emitFragment();
      return;
    }
    const frame: Record<string, unknown>[] = [];
    const delivered: Delivery[] = [];
    let bytes = 2;
    const now = host.now();
    outer: for (const queue of this.#queues) {
      for (const task of queue.values()) {
        if (task.parked || task.settled || task.readyAt > now) continue;
        if (this.#blocked(task)) continue;
        // Isolate a rejected row so its next attempt cannot reject unrelated valid updates.
        if (task.failures && frame.length) break outer;
        const read = task.read;
        const original = read();
        if (original === undefined) {
          queue.delete(task.key);
          continue;
        }
        const patch = task.degraded ? degradedPatch(original) : original;
        const sticky = task.degraded && patch.row != null;
        const json = JSON.stringify(patch);
        const encoded = host.utf8Base64(json);
        const size =
          (encoded.length / 4) * 3 - (encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0);
        if (size > 32760) {
          if (frame.length) break outer;
          this.#fragment = {
            task,
            read,
            sticky,
            id: host.uuid(),
            data: encoded,
            offset: 0,
            index: 0,
          };
          this.#emitFragment();
          return;
        }
        if (bytes + size + 1 > 32768 || frame.length >= 32) break outer;
        delivered.push({ task, read, sticky });
        frame.push(patch);
        bytes += size + 1;
        if (task.failures) break outer;
      }
    }
    if (frame.length) {
      this.#inFlight = {
        delivered,
        commit: () => {
          for (const entry of delivered) this.#confirm(entry);
        },
      };
      host.emit(JSON.stringify(frame));
    } else this.#schedule();
  }
  #emitFragment(): void {
    const fragment = this.#fragment;
    if (!fragment) return;
    const data = fragment.data.slice(fragment.offset, fragment.offset + 24576);
    const last = fragment.offset + data.length === fragment.data.length;
    this.#inFlight = {
      delivered: [fragment],
      commit: () => {
        if (last) {
          this.#confirm(fragment);
          this.#fragment = undefined;
        } else {
          fragment.offset += data.length;
          fragment.index++;
        }
      },
    };
    host.emit(
      JSON.stringify([{ type: "fragment", id: fragment.id, index: fragment.index, last, data }]),
    );
  }
  #confirm({ task, read, sticky }: Delivery): void {
    const queue = this.#queue(task.key);
    if (queue.get(task.key) !== task) return; // A navigation reset replaced this task.
    queue.delete(task.key);
    if (task.read !== read) {
      // The newer reader stays dirty, but yields its old position to pending peers.
      task.failures = 0;
      task.readyAt = 0;
      queue.set(task.key, task);
    } else if (sticky) {
      // Delivery is confirmed. Remember degraded mode until deletion/resnapshot, so
      // continuous poisoned deltas cannot start a fresh raw retry budget each time.
      task.settled = true;
      queue.set(task.key, task);
    }
  }
  #reject({ task, read }: Delivery): void {
    const queue = this.#queue(task.key);
    if (queue.get(task.key) !== task) return;
    task.failures++;
    queue.delete(task.key);
    queue.set(task.key, task);
    if (task.degraded && task.read !== read) {
      // An older failure cannot quarantine newer canonical data. Retain degraded
      // mode and the retry budget, and give the replacement one bounded retry.
      task.readyAt = host.now() + 1000;
      return;
    }
    if (task.degraded) {
      // Even an undecodable canonical identity cannot spin or block unrelated work.
      // Retain it without acknowledgment until a changed reader or resnapshot can retry.
      task.parked = true;
      if (task.key !== "bridge:delivery-error")
        this.put("bridge:delivery-error", () => ({
          type: "error",
          message: "An update could not be displayed. Reconnect or check your machine.",
        }));
    } else {
      task.readyAt = host.now() + ([32, 128, 512][task.failures - 1] ?? 512);
      if (task.failures >= 3) task.degraded = true;
    }
  }
}
