import { obj, str, type Obj } from "./native.ts";

type Request = { native: string; observedTurn?: string };
type Buffer = {
  task: string;
  frames: Map<string, { params: Obj; bytes: number }>;
  bytes: number;
  overflow: boolean;
};

/** Correlate partial turn streams without deciding that an unidentified end is current. */
export class PendingCompletions {
  #requests = new Map<string, Request>();
  #buffers = new Map<string, Buffer>();

  open(key: string, native: string, observedTurn: string | undefined): void {
    this.#requests.set(key, { native, ...(observedTurn === undefined ? {} : { observedTurn }) });
  }

  hold(native: string, params: Obj, latestTurn: string | undefined) {
    const turn = str(obj(params["turn"])["id"]);
    const buffered = this.#buffers.get(native)?.frames.has(turn);
    if (
      !turn ||
      ![...this.#requests.values()].some(
        (request) => request.native === native && (request.observedTurn === latestTurn || buffered),
      )
    )
      return undefined;
    let buffer = this.#buffers.get(native);
    const first = !buffer;
    if (!buffer) {
      buffer = {
        task: `codex:turn-correlation:${native}`,
        frames: new Map(),
        bytes: 0,
        overflow: false,
      };
      this.#buffers.set(native, buffer);
    }
    if (buffer.overflow || buffer.frames.has(turn))
      return { task: buffer.task, first, overflow: false };
    const bytes = new TextEncoder().encode(JSON.stringify(params)).length;
    const overflow = buffer.bytes + bytes > 2 * 1024 * 1024 || buffer.frames.size >= 128;
    if (overflow) {
      buffer.frames.clear();
      buffer.bytes = 0;
      buffer.overflow = true;
    } else {
      buffer.frames.set(turn, { params, bytes });
      buffer.bytes += bytes;
    }
    return { task: buffer.task, first, overflow };
  }

  has(native: string, turn: string): boolean {
    return this.#buffers.get(native)?.frames.has(turn) === true;
  }

  resolve(key: string, acknowledged: string | undefined, latestTurn: string | undefined) {
    const request = this.#requests.get(key);
    this.#requests.delete(key);
    if (!request) return undefined;
    const buffer = this.#buffers.get(request.native);
    if (!buffer) return undefined;
    const match =
      acknowledged && (request.observedTurn === latestTurn || latestTurn === acknowledged)
        ? buffer.frames.get(acknowledged)
        : undefined;
    if (match && acknowledged) {
      buffer.frames.delete(acknowledged);
      buffer.bytes -= match.bytes;
    }
    const pending = [...this.#requests.values()].some((entry) => entry.native === request.native);
    const historical = pending ? [] : [...buffer.frames.values()].map((entry) => entry.params);
    if (!pending) {
      buffer.frames.clear();
      buffer.bytes = 0;
      if (!buffer.overflow) this.#buffers.delete(request.native);
    }
    return {
      native: request.native,
      task: buffer.task,
      current: match?.params,
      historical,
      settled: !pending && !buffer.overflow,
    };
  }
}
