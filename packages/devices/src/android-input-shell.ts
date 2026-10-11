import { spawnSupervised, type SupervisedProcess } from "@ace/provider-kit/process";
import { DeviceError } from "./sdk.ts";

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
      args: ["-s", options.serial, "shell", "-T"],
      env: options.env,
      name: "device-input",
      maxLineBytes: 4096,
    });
    this.process.stdout.on("line", (line: string) => {
      const pending = this.pending;
      if (!pending || !line.startsWith(pending.marker)) return;
      this.pending = undefined;
      pending.cancel();
      if (line === pending.marker + "0") pending.resolve();
      else pending.reject(this.failure());
    });
    void this.process.exited.then(() => {
      this.closed = true;
      this.reject();
    });
  }
  private readonly after: (ms: number, run: () => void) => () => void;
  private failure() {
    return new DeviceError(
      "command_failed",
      "Android input transport ended or refused input",
      "Reconnect the emulator and take control again.",
    );
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
        const marker = `ACE_INPUT_${++this.sequence}:`;
        await new Promise<void>((resolve, reject) => {
          const cancel = this.after(timeoutMs, () => {
            this.reject();
            void this.close();
          });
          this.pending = { marker, resolve, reject, cancel };
          this.process.stdin.write(`${command}\nprintf '\\n${marker}%s\\n' "$?"\n`, (error) => {
            if (error) {
              this.reject();
              void this.close();
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
