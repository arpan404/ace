import { DeviceError } from "./sdk.ts";
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
  }
  /** A message the device sent on the control socket. */
  received(message: DeviceMessage): void {
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
    if (this.reading)
      return Promise.reject(
        new DeviceError("busy", "A clipboard read is already waiting", "Retry shortly."),
      );
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
    const sequence = ++this.sequence;
    return new Promise<void>((resolve, reject) => {
      const cancel = this.options.after(ackMs, () => {
        this.acks.delete(sequence);
        reject(
          new DeviceError(
            "command_failed",
            paste ? "Android paste timed out" : "Android clipboard write timed out",
            "Retry the text.",
          ),
        );
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
    for (const finish of this.acks.values()) finish();
    this.acks.clear();
    this.outstanding.length = 0;
    const reading = this.reading;
    this.reading = undefined;
    reading?.reject(
      new DeviceError("busy", "Android control restarted during a clipboard read", "Retry."),
    );
  }
}
