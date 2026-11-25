import { spawnSupervised, type SupervisedProcess } from "@ace/provider-kit/process";
import { catalogRefusal } from "./sdk.ts";
import { nativeInput, nativeInputAnswer } from "./native-input.ts";
import { nativeDevices } from "./native-devices-addon.ts";

/** One pinned adb shell per transport. A failed/disconnected action is never replayed. */
export class AndroidInputShell {
  readonly serial: string;
  private readonly process: SupervisedProcess;
  private sequence = 0;
  private queued = 0;
  private tail: Promise<void> = Promise.resolve();
  private closed = false;
  private pending:
    | { marker: string; resolve(): void; reject(error: Error): void; cancel(): void }
    | undefined;
  constructor(options: {
    adb: string;
    serial: string;
    env: NodeJS.ProcessEnv;
    spawn: typeof spawnSupervised;
    after(ms: number, run: () => void): () => void;
  }) {
    this.serial = options.serial;
    this.after = options.after;
    this.process = options.spawn({
      command: options.adb,
      // The pinned shell's arguments are ace-devices' decision under the switch.
      args: nativeInput
        ? (nativeDevices().devicePlatformInputShell(options.serial, "", 0)[0]?.split("\u0001") ??
          [])
        : ["-s", options.serial, "shell", "-T"],
      env: options.env,
      name: "device-input",
      maxLineBytes: 4096,
    });
    this.process.stdout.on("line", (line: string) => {
      const pending = this.pending;
      if (!pending) return;
      const succeeded = nativeInput
        ? nativeInputAnswer(line, pending.marker)
        : line.startsWith(pending.marker)
          ? line === pending.marker + "0"
          : null;
      if (succeeded === null) return;
      this.pending = undefined;
      pending.cancel();
      if (succeeded) pending.resolve();
      else pending.reject(this.failure());
    });
    // `exited` reports the shell's exit and does not reject.
    void this.process.exited
      .then(() => {
        this.closed = true;
        this.reject();
      })
      .catch(() => {});
  }
  private readonly after: (ms: number, run: () => void) => () => void;
  private failure() {
    return catalogRefusal("androidInputEnded");
  }
  private reject() {
    const pending = this.pending;
    this.pending = undefined;
    pending?.cancel();
    pending?.reject(this.failure());
  }
  send(command: string, authorize: () => void, timeoutMs = 5000): Promise<void> {
    if (this.closed || this.queued >= 32) return Promise.reject(this.failure());
    this.queued++;
    const action = this.tail
      .then(async () => {
        if (this.closed) throw this.failure();
        authorize();
        const marker = nativeInput
          ? (nativeDevices().devicePlatformInputShell("", "", ++this.sequence)[2] ??
            `ACE_INPUT_${this.sequence}:`)
          : `ACE_INPUT_${++this.sequence}:`;
        await new Promise<void>((resolve, reject) => {
          const cancel = this.after(timeoutMs, () => {
            this.reject();
            // The pending input has already failed; a close that cannot finish adds nothing.
            void this.close().catch(() => {});
          });
          this.pending = { marker, resolve, reject, cancel };
          const line = nativeInput
            ? (nativeDevices().devicePlatformInputShell("", command, this.sequence)[1] ??
              `${command}\n`)
            : `${command}\nprintf '\\n${marker}%s\\n' "$?"\n`;
          this.process.stdin.write(line, (error) => {
            if (error) {
              this.reject();
              // The pending input has already failed; a close that cannot finish adds nothing.
              void this.close().catch(() => {});
            }
          });
        });
      })
      .finally(() => {
        this.queued--;
      });
    this.tail = action.catch(() => {});
    return action;
  }
  async close(): Promise<void> {
    this.closed = true;
    this.reject();
    await this.process.stop({ graceMs: 0 });
  }
}
