import { DeviceError } from "./sdk.ts";
import type { ControlMessage, DeviceMessage } from "./scrcpy-protocol.ts";

/**
 * How long a clipboard read waits for the device's reply. The server answers a read only when
 * the clipboard holds text, so silence means it is empty.
 */
export const clipboardReplyMs = 1500;
/** How long a clipboard write waits for the server to acknowledge its sequence number. */
const ackMs = 5000;

/**
 * The clipboard over one scrcpy control socket: reads wait for the device's clipboard message,
 * writes for the acknowledgement of their sequence number. Pure apart from the injected send
 * and timer.
 */
export class ScrcpyClipboard {
  private readonly acks = new Map<bigint, () => void>();
  private reading: { resolve(text: string): void; reject(error: Error): void } | undefined;
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
      const reading = this.reading;
      this.reading = undefined;
      reading?.resolve(message.text);
    }
  }
  /** The device clipboard's text; empty when the device does not answer. */
  read(): Promise<string> {
    if (this.reading)
      return Promise.reject(
        new DeviceError("busy", "A clipboard read is already waiting", "Retry shortly."),
      );
    return new Promise<string>((resolve, reject) => {
      const cancel = this.options.after(clipboardReplyMs, () => {
        if (this.reading !== reading) return;
        this.reading = undefined;
        resolve("");
      });
      const reading = {
        resolve(text: string) {
          cancel();
          resolve(text);
        },
        reject(error: Error) {
          cancel();
          reject(error);
        },
      };
      this.reading = reading;
      try {
        this.options.send({ type: "getClipboard" });
      } catch (error) {
        this.reading = undefined;
        reading.reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
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
    const reading = this.reading;
    this.reading = undefined;
    reading?.reject(
      new DeviceError("busy", "Android control restarted during a clipboard read", "Retry."),
    );
  }
}
