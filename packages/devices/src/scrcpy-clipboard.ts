import { catalogRefusal, deviceRefusal } from "./sdk.ts";
import type { RefusalWord } from "./native-devices-addon.ts";
import { nativeClipboardStep, nativeInput } from "./native-input.ts";
import type { ControlMessage, DeviceMessage } from "./scrcpy-protocol.ts";

/**
 * How long a clipboard read waits for the device's reply. The server answers a read only when
 * the clipboard holds text, so silence means it is empty.
 */
export const clipboardReplyMs = 1500;
/**
 * How long after it was sent a request whose read gave up may still be answered. scrcpy's
 * clipboard replies name no request, only the text, so until then a reply could be that one's.
 */
export const clipboardSettleMs = 10_000;
/** How long a clipboard write waits for the server to acknowledge its sequence number. */
const ackMs = 5000;

/** A request on the socket the device may still answer, and whose read it is. */
type Request = { owner: string };
/** The one read in progress: waiting to send its request, then for the reply. */
type Read = {
  owner: string;
  request: Request | undefined;
  resolve(text: string): void;
  reject(error: Error): void;
};

/**
 * The clipboard over one scrcpy control socket: reads wait for the device's clipboard message,
 * writes for the acknowledgement of their sequence number. Pure apart from the injected send
 * and timer.
 *
 * The server answers requests in order, but a reply carries no request id and an empty
 * clipboard gets no reply at all. So every request stays outstanding until a reply pays for it
 * (the oldest first) or it settles, and a read whose owner differs from an outstanding request's
 * waits to send its own until that one is paid or settled: a reply it then gets can only be its
 * own or an earlier one of the same owner. A person's late answer never reaches an agent's read.
 */
export class ScrcpyClipboard {
  /** The Rust machine's state and promises under the switch. */
  private readonly native: NativeClipboard | undefined;
  private readonly acks = new Map<bigint, () => void>();
  private reading: Read | undefined;
  private readonly outstanding: Request[] = [];
  private sequence = 0n;
  private readonly options: {
    send(message: ControlMessage): void;
    after(ms: number, run: () => void): () => void;
  };
  constructor(options: ScrcpyClipboard["options"]) {
    this.options = options;
    this.native = nativeInput ? new NativeClipboard(options) : undefined;
  }
  /** A message the device sent on the control socket. */
  received(message: DeviceMessage): void {
    if (this.native) {
      this.native.received(message);
      return;
    }
    if (message.type === "clipboardAck") {
      this.acks.get(message.sequence)?.();
      this.acks.delete(message.sequence);
    } else if (message.type === "clipboard") {
      // Nothing asked: not an answer to anyone.
      if (!this.outstanding.shift()) return;
      const reading = this.reading;
      if (reading?.request) {
        this.reading = undefined;
        reading.resolve(message.text);
      } else this.proceed();
    }
  }
  /** The device clipboard's text for `owner`'s read; empty when the device does not answer. */
  read(owner: string): Promise<string> {
    if (this.native) return this.native.read(owner);
    if (this.reading) return Promise.reject(catalogRefusal("clipboardReadWaiting"));
    return new Promise<string>((resolve, reject) => {
      this.reading = { owner, request: undefined, resolve, reject };
      this.proceed();
    });
  }
  /** Sends the waiting read's request once no other owner's may still be answered. */
  private proceed(): void {
    const reading = this.reading;
    if (!reading || reading.request) return;
    if (this.outstanding.some((request) => request.owner !== reading.owner)) return;
    const request: Request = { owner: reading.owner };
    this.outstanding.push(request);
    reading.request = request;
    this.options.after(clipboardSettleMs, () => {
      const index = this.outstanding.indexOf(request);
      if (index >= 0) this.outstanding.splice(index, 1);
      this.proceed();
    });
    const cancel = this.options.after(clipboardReplyMs, () => {
      if (this.reading !== reading) return;
      this.reading = undefined;
      reading.resolve("");
    });
    const { resolve, reject } = reading;
    reading.resolve = (text) => {
      cancel();
      resolve(text);
    };
    reading.reject = (error) => {
      cancel();
      reject(error);
    };
    try {
      this.options.send({ type: "getClipboard" });
    } catch (error) {
      this.outstanding.splice(this.outstanding.indexOf(request), 1);
      this.reading = undefined;
      reading.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }
  /** Puts `text` on the device clipboard, and pastes it into the focused field when asked. */
  write(text: string, paste: boolean): Promise<void> {
    if (this.native) return this.native.write(text, paste);
    const sequence = ++this.sequence;
    return new Promise<void>((resolve, reject) => {
      const cancel = this.options.after(ackMs, () => {
        this.acks.delete(sequence);
        reject(catalogRefusal(paste ? "pasteTimedOut" : "clipboardWriteTimedOut"));
      });
      this.acks.set(sequence, () => {
        cancel();
        resolve();
      });
      try {
        this.options.send({ type: "setClipboard", sequence, text, paste });
      } catch (error) {
        cancel();
        this.acks.delete(sequence);
        reject(error);
      }
    });
  }
  /**
   * The socket closed. Waiting writes finish, as the server can no longer answer them; a waiting
   * read fails, since an empty answer would claim the clipboard is empty.
   */
  close(): void {
    if (this.native) {
      this.native.close();
      return;
    }
    for (const finish of this.acks.values()) finish();
    this.acks.clear();
    this.outstanding.length = 0;
    const reading = this.reading;
    this.reading = undefined;
    reading?.reject(catalogRefusal("androidControlRestarted"));
  }
}

/** What one step of the Rust clipboard asks the shell to do. */
type ClipboardOut =
  | { kind: "send"; message: ControlMessage; read: number | null }
  | { kind: "timer"; id: number; afterMs: number }
  | { kind: "readDone"; id: number; result: { Ok: string } | { Err: RefusalWord } }
  | { kind: "writeDone"; sequence: number; result: { Ok?: null } | { Err: RefusalWord } };

/**
 * The clipboard over one scrcpy control socket, decided by `ace-devices` (D3.2): the shell owns
 * the timers and the promises, the ordering and every refusal are the Rust machine's.
 */
class NativeClipboard {
  #state: string | null = null;
  #nextId = 1;
  #readers = new Map<number, { resolve(text: string): void; reject(error: unknown): void }>();
  #writes: { sequence?: bigint; resolve(): void; reject(error: unknown): void }[] = [];
  readonly #options: ScrcpyClipboardOptions;

  constructor(options: ScrcpyClipboardOptions) {
    this.#options = options;
  }

  read(owner: string): Promise<string> {
    const id = this.#nextId++;
    return new Promise<string>((resolve, reject) => {
      this.#readers.set(id, { resolve, reject });
      this.#step({ kind: "read", id, owner });
    });
  }

  write(text: string, paste: boolean): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.#writes.push({ resolve, reject });
      this.#step({ kind: "write", text, paste });
    });
  }

  received(message: DeviceMessage): void {
    this.#step({ kind: "received", message });
  }

  close(): void {
    this.#step({ kind: "close" });
  }

  #step(event: unknown): void {
    const answer = nativeClipboardStep(this.#state, event);
    this.#state = JSON.stringify(answer.state);
    for (const out of answer.out as ClipboardOut[]) this.#apply(out);
  }

  #apply(out: ClipboardOut): void {
    if (out.kind === "send") return this.#send(out.message, out.read);
    if (out.kind === "timer") {
      this.#options.after(out.afterMs, () => this.#step({ kind: "tick", id: out.id }));
      return;
    }
    if (out.kind === "readDone") {
      const reader = this.#readers.get(out.id);
      this.#readers.delete(out.id);
      if (!reader) return;
      if ("Ok" in out.result) reader.resolve(out.result.Ok);
      else reader.reject(deviceRefusal(out.result.Err));
      return;
    }
    const write = this.#writes.find((each) => each.sequence === BigInt(out.sequence));
    if (!write) return;
    this.#writes.splice(this.#writes.indexOf(write), 1);
    if ("Err" in out.result) write.reject(deviceRefusal(out.result.Err));
    else write.resolve();
  }

  /** Sends one message; a send that throws settles what it belonged to, as today's code does. */
  #send(message: ControlMessage, read: number | null): void {
    if (message.type === "setClipboard") {
      // The addon writes a `bigint` as its digits; the socket and the promise key want a bigint.
      const sequence = BigInt(String(message.sequence));
      message.sequence = sequence;
      const write = this.#writes.find((each) => each.sequence === undefined);
      if (write) write.sequence = sequence;
    }
    try {
      this.#options.send(message);
    } catch (error) {
      if (message.type === "setClipboard") {
        this.#step({ kind: "sendFailed", sequence: Number(message.sequence) });
        // (`message.sequence` is a bigint by now; the event takes its number form.)
        const index = this.#writes.findIndex((each) => each.sequence === message.sequence);
        const write = index >= 0 ? this.#writes.splice(index, 1)[0] : undefined;
        write?.reject(error);
        return;
      }
      // The read whose request this was, even when it was sent after a deferral.
      this.#step({ kind: "sendFailed", read });
      const reader = read === null ? undefined : this.#readers.get(read);
      if (read !== null) this.#readers.delete(read);
      reader?.reject(error);
    }
  }
}

/** The clipboard's options, as the class declares them. */
type ScrcpyClipboardOptions = {
  send(message: ControlMessage): void;
  after(ms: number, run: () => void): () => void;
};
