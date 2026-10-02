import {
  spawnSupervised,
  type SpawnOptions,
  type SupervisedProcess,
} from "@ace/provider-kit/process";
import {
  ScreenHelperReply,
  ScreenHelperRequest,
  ScreenHelperReplyV2,
  ScreenHelperRequestV2,
  ScreenCapabilities,
  ScreenPermissionsV2,
} from "@ace/protocol";
import { frameChannel } from "./transport.ts";
import { spawnWindowsHelper } from "./windows-process.ts";
import { FrameDecoder, type Frame } from "./frames.ts";

export type HelperOptions = {
  command: string;
  platform?: NodeJS.Platform;
  protocolVersion?: 1 | 2;
  /** Test boundary for a helper-owned local IPC server. */
  endpoint?: string;
  args?: readonly string[];
  env?: NodeJS.ProcessEnv;
  spawn?: (options: SpawnOptions) => SupervisedProcess;
  nextId: () => string;
  onFrame: (frame: Frame) => void;
  onFailure: (error: Error) => void;
  timeoutMs?: number;
};
type WithoutEnvelope<T> = T extends unknown ? Omit<T, "version" | "id"> : never;
export class Helper {
  private readonly pending = new Map<
    string,
    {
      resolve: (data: unknown) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private readonly recent: unknown[] = [];
  private closed = false;
  capabilities: ScreenCapabilities | undefined;
  private get version(): 1 | 2 {
    return (
      this.options.protocolVersion ??
      ((this.options.platform ?? process.platform) === "win32" ? 2 : 1)
    );
  }
  private readonly proc: SupervisedProcess;
  private readonly cleanup: () => Promise<void>;
  private readonly options: HelperOptions;
  private closing: Promise<void> | undefined;
  private constructor(
    proc: SupervisedProcess,
    cleanup: () => Promise<void>,
    options: HelperOptions,
  ) {
    this.proc = proc;
    this.cleanup = cleanup;
    this.options = options;
    proc.stdout.on("line", (line: string) => {
      try {
        if (Buffer.byteLength(line) > 1024 * 1024) throw new Error("Helper reply exceeds limit");
        const reply = (this.version === 2 ? ScreenHelperReplyV2 : ScreenHelperReply).parse(
          JSON.parse(line),
        );
        this.recent.push(reply);
        if (this.recent.length > 16) this.recent.shift();
        const pending = this.pending.get(reply.id);
        if (!pending) return;
        this.pending.delete(reply.id);
        clearTimeout(pending.timer);
        if (reply.ok) pending.resolve(reply.data);
        else
          pending.reject(
            typeof reply.error === "object"
              ? new HelperCommandError(reply.error.code, reply.error.message)
              : new Error(reply.error ?? "Helper rejected command"),
          );
      } catch (error) {
        this.fail(error instanceof Error ? error : new Error("Invalid helper reply"));
      }
    });
    void proc.exited.then(() => this.fail(new Error("Screen helper exited")));
  }
  static async open(options: HelperOptions): Promise<Helper> {
    let helper: Helper | undefined;
    const platform = options.platform ?? process.platform;
    const version = options.protocolVersion ?? (platform === "win32" ? 2 : 1);
    const decoder = new FrameDecoder(options.onFrame);
    const channel = await frameChannel(
      {
        platform,
        version,
        id: options.nextId(),
        ...(options.endpoint === undefined ? {} : { endpoint: options.endpoint }),
      },
      (chunk) => {
        try {
          decoder.push(chunk);
        } catch (error) {
          helper?.fail(error instanceof Error ? error : new Error("Invalid frame"));
        }
      },
      (error) => helper?.fail(error),
    );
    try {
      const proc = (options.spawn ?? (platform === "win32" ? spawnWindowsHelper : spawnSupervised))(
        {
          command: options.command,
          args: [...(options.args ?? []), ...channel.args],
          env: options.env ?? {},
          name: "screen-helper",
        },
      );
      helper = new Helper(proc, channel.close, options);
      if (version === 2) {
        helper.capabilities = ScreenCapabilities.parse(await helper.requestV2({ op: "hello" }));
        if (platform === "win32" && helper.capabilities.platform !== "windows")
          throw new Error("Helper platform differs from host");
        if (!helper.capabilities.codecs.includes("jpeg"))
          throw new Error("Helper does not support JPEG");
      }
      await channel.connect();
      return helper;
    } catch (error) {
      if (helper) await helper.close();
      else await channel.close();
      throw error;
    }
  }
  request(command: WithoutEnvelope<ScreenHelperRequest>): Promise<unknown> {
    const result = this.send(command);
    if (command.op !== "permissions" || this.version === 1) return result;
    return result.then((data) => {
      const permissions = ScreenPermissionsV2.parse(data);
      return {
        screenRecording: ["granted", "n/a"].includes(permissions.screen),
        accessibility: ["granted", "n/a"].includes(permissions.input),
      };
    });
  }
  requestV2(command: WithoutEnvelope<ScreenHelperRequestV2>): Promise<unknown> {
    if (this.version !== 2)
      return Promise.reject(new HelperCommandError("not_supported", "Helper uses protocol v1"));
    return this.send(command);
  }
  private send(
    command: WithoutEnvelope<ScreenHelperRequest> | WithoutEnvelope<ScreenHelperRequestV2>,
  ): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error("Helper is closed"));
    if (this.pending.size >= 32) return Promise.reject(new Error("Helper request limit"));
    const request = (this.version === 2 ? ScreenHelperRequestV2 : ScreenHelperRequest).parse({
      ...command,
      version: this.version,
      id: this.options.nextId(),
    });
    const line = `${JSON.stringify(request)}\n`;
    if (Buffer.byteLength(line) > 64 * 1024)
      return Promise.reject(new HelperCommandError("bounds", "Helper command exceeds limit"));
    if (this.pending.has(request.id)) return Promise.reject(new Error("Duplicate request id"));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => this.fail(new Error("Helper command timed out")),
        this.options.timeoutMs ?? 10_000,
      );
      this.pending.set(request.id, { resolve, reject, timer });
      this.proc.stdin.write(line, (error) => {
        if (error) this.fail(error);
      });
    });
  }
  private fail(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    try {
      this.options.onFailure(error);
    } finally {
      void this.proc.stop({ graceMs: 0 });
      void this.close();
    }
  }
  diagnostics(): readonly unknown[] {
    return [...this.recent];
  }
  close(): Promise<void> {
    this.closing ??= this.finish();
    return this.closing;
  }
  private async finish(): Promise<void> {
    if (!this.closed) {
      this.closed = true;
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error("Helper stopped"));
      }
      this.pending.clear();
    }
    await this.proc.stop({ graceMs: 1000 });
    await this.cleanup();
  }
}

export class HelperCommandError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}
