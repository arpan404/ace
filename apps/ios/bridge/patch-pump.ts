import { host, scheduler } from "./host.ts";
import { degradedPatch } from "./degraded-patch.ts";
import { base64 } from "./bytes.ts";
import { keptKey, ledgerText, type NativeLedger } from "./native-ledger.ts";
import { itemPatch } from "./text-edit.ts";

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
  /** What native will hold once this is confirmed, for the open thread's ledger. */
  record?:
    | { ledger: NativeLedger; epoch: number; patch: Record<string, unknown>; text: string }
    | undefined;
}
interface Fragment extends Delivery {
  id: string;
  data: string;
  offset: number;
  index: number;
}

/** ADR 0074: a frame carries at most 32 patches and 32 KiB. */
const framePatches = 32;

function priority(key: string): 0 | 1 | 2 {
  if (key === "inbox:reset" || key === "thread:reset") return 0;
  if (key.startsWith("thread:item:") || key.startsWith("thread:position:")) return 2;
  if (key.startsWith("thread:block") || key === "thread:history") return 2;
  if (key === "thread:ready" || key === "thread:cursor" || key === "changes:file") return 2;
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
  /** The last frame was full, so what remains is backlog rather than a fresh change. */
  #backlog = false;
  #drained: (() => void)[] = [];
  /** The open thread's ledger and navigation generation, while native keeps that thread. */
  #bound: { ledger: NativeLedger; epoch: number } | undefined;

  /** Diff the open thread's patches against what native holds of it (`native-ledger.ts`). */
  bind(ledger: NativeLedger | undefined, epoch: number): void {
    this.#bound = ledger && { ledger, epoch };
  }
  put(key: string, read: Reader): void {
    if (this.#bound?.ledger.passing && keptKey(key)) this.#bound.ledger.touch(key);
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
  /** Resolves once nothing deliverable is waiting or in flight. */
  drained(): Promise<void> {
    return new Promise((resolve) => {
      this.#drained.push(resolve);
      this.#schedule();
    });
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
  /**
   * A few changes wait 8 ms so streaming deltas share a frame. A backlog of at least a full frame
   * (opening a thread, a snapshot, history) or a fragmented patch goes at once: it is already
   * coalesced, and each wait would only add to the frames it takes.
   */
  #schedule(): void {
    if (this.#inFlight) return;
    const now = host.now();
    let next = this.#fragment ? now : Infinity;
    let ready = this.#fragment ? framePatches : 0;
    for (const queue of this.#queues) {
      for (const task of queue.values()) {
        if (task.parked || task.settled || this.#blocked(task)) continue;
        next = Math.min(next, task.readyAt);
        if (task.readyAt <= now) ready++;
        if (ready >= framePatches) break;
      }
      if (ready >= framePatches) break;
    }
    if (next === Infinity) {
      this.#timer?.cancel();
      this.#timer = undefined;
      for (const resolve of this.#drained.splice(0)) resolve();
      return;
    }
    // The rest of a backlog that filled the last frame is coalesced already: it goes at once too.
    const at = ready >= framePatches || this.#backlog ? now : Math.max(now + 8, next);
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
    const bound = this.#bound;
    if (bound?.ledger.passing)
      for (const [key, read] of bound.ledger.close(bound.epoch))
        if (!this.#queue(key).has(key)) this.put(key, read);
    const frame: Record<string, unknown>[] = [];
    /** Each patch's JSON, made once to measure it and reused for the frame. */
    const texts: string[] = [];
    /** Whether this frame filled up, leaving a backlog behind it. */
    let full = false;
    const delivered: Delivery[] = [];
    let bytes = 2;
    const now = host.now();
    const tracing = host.tracing === true;
    let reading = 0;
    let serializing = 0;
    outer: for (const queue of this.#queues) {
      for (const task of queue.values()) {
        if (task.parked || task.settled || task.readyAt > now) continue;
        if (this.#blocked(task)) continue;
        // Isolate a rejected row so its next attempt cannot reject unrelated valid updates.
        if (task.failures && frame.length) break outer;
        const read = task.read;
        const readAt = tracing ? host.now() : 0;
        const original = read();
        if (tracing) reading += host.now() - readAt;
        if (original === undefined) {
          queue.delete(task.key);
          continue;
        }
        const patch = task.degraded ? degradedPatch(original) : original;
        const sticky = task.degraded && patch.row != null;
        const record = this.#record(task, patch);
        if (record && keptKey(task.key) && record.ledger.same(task.key, record.text)) {
          queue.delete(task.key); // Native already shows exactly this.
          continue;
        }
        const serializeAt = tracing ? host.now() : 0;
        // Streaming text crosses as an edit of what native confirmed holding (`text-edit.ts`).
        const sent = record
          ? itemPatch(patch, record.ledger.streaming(task.key), host.utf8Length)
          : patch;
        const json = JSON.stringify(sent);
        const size = host.utf8Length(json);
        if (tracing) serializing += host.now() - serializeAt;
        if (size > 32760) {
          if (frame.length) break outer;
          this.#fragment = {
            task,
            read,
            sticky,
            record,
            id: host.uuid(),
            data: base64(host.encode(json)),
            offset: 0,
            index: 0,
          };
          this.#emitFragment();
          return;
        }
        if (bytes + size + 1 > 32768 || frame.length >= framePatches) {
          full = true;
          break outer;
        }
        delivered.push({ task, read, sticky, record });
        frame.push(sent);
        texts.push(json);
        bytes += size + 1;
        if (task.failures) break outer;
      }
    }
    this.#backlog = full;
    if (frame.length) {
      this.#inFlight = {
        delivered,
        commit: () => {
          for (const entry of delivered) this.#confirm(entry);
        },
      };
      const emitAt = tracing ? host.now() : 0;
      host.emit(`[${texts.join(",")}]`);
      if (tracing) {
        host.trace?.("pump.read", reading, 0);
        host.trace?.("pump.serialize", serializing, bytes);
        host.trace?.("pump.emit", host.now() - emitAt, 0);
        host.trace?.("pump.flush", host.now() - now, frame.length);
      }
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
  /** A thread patch for the bound generation, undegraded, can update the ledger once confirmed. */
  #record(task: Task, patch: Record<string, unknown>): Delivery["record"] {
    const bound = this.#bound;
    if (!bound || task.degraded || !task.key.startsWith("thread:") || patch.epoch !== bound.epoch)
      return undefined;
    return { ...bound, patch, text: ledgerText(patch) };
  }
  #confirm({ task, read, sticky, record }: Delivery): void {
    // Native applied it if its generation is still the open one (it drops older ones).
    if (record && this.#bound?.ledger === record.ledger && this.#bound.epoch === record.epoch)
      record.ledger.delivered(task.key, record.patch, record.text);
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
  #reject({ task, read, record }: Delivery): void {
    // Native's copy may no longer match what it last confirmed: the retry goes whole.
    record?.ledger.forget(task.key);
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
