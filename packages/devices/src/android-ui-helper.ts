import { fileURLToPath } from "node:url";
import type { spawnSupervised, SupervisedProcess } from "@ace/provider-kit/process";
import { DeviceError } from "./sdk.ts";

/** ace's own dex (source and build script beside it), pushed to the emulator on first use. */
export const androidUiHelperJar = fileURLToPath(
  new URL("./android-ui-helper/ace-ui-helper.jar", import.meta.url),
);
const remoteJar = "/data/local/tmp/ace-ui-helper.jar";
/** The tree is one line of XML; the parser's own budget is 1 MiB. */
const maxReplyBytes = 2 * 1024 * 1024;

const failed = (message: string) =>
  new DeviceError(
    "command_failed",
    message,
    "Read the UI tree again; ace falls back to uiautomator.",
  );

/**
 * One long-running UiAutomation reader on one emulator. Requests are answered in order over the
 * helper's stdin and stdout. It exits after `idleMs` without a request, so UiAutomation (which
 * the system lets only one client hold) is free again for test runners and `uiautomator`.
 */
export class AndroidUiHelper {
  readonly serial: string;
  private readonly process: SupervisedProcess;
  private readonly after: (ms: number, run: () => void) => () => void;
  private readonly idleMs: number;
  private readonly ready: Promise<void>;
  private waiting: { resolve(line: string): void; reject(error: Error): void }[] = [];
  private tail: Promise<unknown> = Promise.resolve();
  private idle: (() => void) | undefined;
  private closed = false;
  constructor(options: {
    adb: string;
    serial: string;
    env: NodeJS.ProcessEnv;
    spawn: typeof spawnSupervised;
    after(ms: number, run: () => void): () => void;
    idleMs?: number;
    startupMs?: number;
  }) {
    this.serial = options.serial;
    this.after = options.after;
    this.idleMs = options.idleMs ?? 30_000;
    this.process = options.spawn({
      command: options.adb,
      args: [
        "-s",
        options.serial,
        "shell",
        "-T",
        `CLASSPATH=${remoteJar} app_process / dev.ace.uihelper.Main`,
      ],
      env: options.env,
      name: "device-ui-helper",
      maxLineBytes: maxReplyBytes,
    });
    const started = Promise.withResolvers<void>();
    const cancelStartup = this.after(options.startupMs ?? 10_000, () => {
      started.reject(failed("Android UI helper did not start"));
      void this.close();
    });
    this.ready = started.promise.finally(cancelStartup);
    void this.ready.catch(() => {});
    this.process.stdout.on("line", (line: string) => {
      if (line === "READY") {
        started.resolve();
        return;
      }
      if (!line.startsWith("OK ") && !line.startsWith("ERR ")) return;
      this.waiting.shift()?.resolve(line);
    });
    this.process.stderr.on("line", () => {});
    void this.process.exited.then(() => {
      this.closed = true;
      started.reject(failed("Android UI helper exited"));
      for (const waiter of this.waiting.splice(0))
        waiter.reject(failed("Android UI helper exited"));
    });
    this.touch();
  }
  get running(): boolean {
    return !this.closed;
  }
  /** The current UI tree in uiautomator's dump XML. */
  tree(timeoutMs = 5000): Promise<string> {
    const request = this.tail.then(async () => {
      await this.ready;
      if (this.closed) throw failed("Android UI helper exited");
      this.touch();
      const reply = await new Promise<string>((resolve, reject) => {
        const cancel = this.after(timeoutMs, () => {
          reject(failed("Android UI helper timed out"));
          void this.close();
        });
        this.waiting.push({
          resolve: (line) => {
            cancel();
            resolve(line);
          },
          reject: (error) => {
            cancel();
            reject(error);
          },
        });
        this.process.stdin.write("tree\n", (error) => {
          if (error) void this.close();
        });
      });
      this.touch();
      if (reply.startsWith("ERR ")) throw failed(`Android UI helper: ${reply.slice(4)}`);
      return reply.slice(3);
    });
    this.tail = request.catch(() => {});
    return request;
  }
  private touch() {
    this.idle?.();
    this.idle = this.after(this.idleMs, () => void this.close());
  }
  async close(): Promise<void> {
    this.closed = true;
    this.idle?.();
    // Closing stdin lets the helper disconnect UiAutomation itself; a stuck one is killed.
    this.process.stdin.end();
    let cancel: (() => void) | undefined;
    const exited = await Promise.race([
      this.process.exited.then(() => true),
      new Promise<false>((resolve) => {
        cancel = this.after(1000, () => resolve(false));
      }),
    ]);
    cancel?.();
    if (!exited) await this.process.stop({ graceMs: 1000 });
  }
}

/** At most one helper per emulator, replaced when its transport changes or it exits. */
export class AndroidUiHelpers {
  private readonly helpers = new Map<string, AndroidUiHelper>();
  private readonly starting = new Map<string, Promise<AndroidUiHelper>>();
  private readonly options: {
    env: NodeJS.ProcessEnv;
    spawn: typeof spawnSupervised;
    after(ms: number, run: () => void): () => void;
    /** Copies the helper jar to the emulator, on the identity-checked transport. */
    install(serial: string, local: string, remote: string): Promise<void>;
    idleMs?: number;
  };
  constructor(options: AndroidUiHelpers["options"]) {
    this.options = options;
  }
  async tree(id: string, adb: string, serial: string): Promise<string> {
    const helper = await this.helper(id, adb, serial);
    try {
      return await helper.tree();
    } catch (error) {
      // A failed helper gives UiAutomation back before anyone falls back to uiautomator.
      if (this.helpers.get(id) === helper) this.helpers.delete(id);
      await helper.close();
      throw error;
    }
  }
  private async helper(id: string, adb: string, serial: string): Promise<AndroidUiHelper> {
    const current = this.helpers.get(id);
    if (current?.running && current.serial === serial) return current;
    const pending = this.starting.get(id);
    if (pending) return pending;
    const start = (async () => {
      this.helpers.delete(id);
      await current?.close();
      await this.options.install(serial, androidUiHelperJar, remoteJar);
      const helper = new AndroidUiHelper({
        adb,
        serial,
        env: this.options.env,
        spawn: this.options.spawn,
        after: this.options.after,
        ...(this.options.idleMs === undefined ? {} : { idleMs: this.options.idleMs }),
      });
      this.helpers.set(id, helper);
      return helper;
    })();
    this.starting.set(id, start);
    try {
      return await start;
    } finally {
      this.starting.delete(id);
    }
  }
  /** Stops helpers whose emulator is gone or now answers on another serial. */
  prune(current: (id: string) => string | undefined): void {
    for (const [id, helper] of this.helpers)
      if (current(id) !== helper.serial) {
        this.helpers.delete(id);
        void helper.close();
      }
  }
  async close(): Promise<void> {
    const helpers = [...this.helpers.values()];
    this.helpers.clear();
    await Promise.allSettled(helpers.map((helper) => helper.close()));
  }
}
