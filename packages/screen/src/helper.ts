import { frameChannel } from "./transport.ts";
import { spawnWindowsHelper } from "./windows-process.ts";
import { ScreenHelperRequestV2, ScreenPermissionsV2 } from "@ace/protocol";
import { createServer, type Socket } from "node:net";
import {
  spawnSupervised,
  type SpawnOptions,
  type SupervisedProcess,
} from "@ace/provider-kit/process";
import {
  ScreenEndpoint,
  ScreenCapabilities,
  ScreenHelperReply,
  ScreenHelperRequest,
} from "@ace/protocol";
import { localFrameEndpoint, type FrameEndpoint } from "./endpoint.ts";
import { nodeScheduler } from "./runtime.ts";
import { FrameDecoder, type Frame } from "./frames.ts";

export type HelperOptions = {
  command: string;
  platform?: NodeJS.Platform;
  protocolVersion?: 1 | 2;
  expectedPlatform?: ScreenCapabilities["platform"];
  prepare?: () => Promise<string>;
  endpoint?: (() => Promise<FrameEndpoint>) | string;
  transport?: "endpoint" | "legacy";
  args?: readonly string[];
  env?: NodeJS.ProcessEnv;
  spawn?: (options: SpawnOptions) => SupervisedProcess;
  nextId: () => string;
  onFrame: (frame: Frame) => void;
  onFailure: (error: Error) => void;
  timeoutMs?: number;
  scheduler?: { schedule: (callback: () => void, milliseconds: number) => () => void };
};
type WithoutEnvelope<T> = T extends unknown ? Omit<T, "version" | "id"> : never;
export class Helper {
  private readonly pending = new Map<
    string,
    {
      resolve: (data: unknown) => void;
      reject: (error: Error) => void;
      cancel: () => void;
    }
  >();
  private readonly recent: unknown[] = [];
  capabilities: ScreenCapabilities | undefined;
  private closed = false;
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
        if (Buffer.byteLength(line) > 64 * 1024) throw new Error("Helper reply exceeds limit");
        const reply = ScreenHelperReply.parse(JSON.parse(line));
        this.recent.push(reply);
        if (this.recent.length > 16) this.recent.shift();
        const pending = this.pending.get(reply.id);
        if (!pending) return;
        this.pending.delete(reply.id);
        pending.cancel();
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
    if ((options.platform ?? process.platform) === "win32") {
      let helper: Helper | undefined;
      const decoder = new FrameDecoder(options.onFrame);
      const channel = await frameChannel(
        {
          platform: "win32",
          version: 2,
          id: options.nextId(),
          ...(typeof options.endpoint === "string" ? { endpoint: options.endpoint } : {}),
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
        const proc = (options.spawn ?? spawnWindowsHelper)({
          command: options.command,
          args: [...(options.args ?? []), ...channel.args],
          env: options.env ?? {},
          name: "screen-helper",
          maxLineBytes: 1024 * 1024,
          onOutputLimit: (error) => helper?.fail(error),
        });
        helper = new Helper(proc, channel.close, options);
        helper.capabilities = ScreenCapabilities.parse(await helper.requestV2({ op: "hello" }));
        if (
          helper.capabilities.platform !== "windows" ||
          !helper.capabilities.codecs.includes("jpeg")
        )
          throw new Error("Helper platform or codec differs from host");
        await channel.connect();
        return helper;
      } catch (error) {
        if (helper) await helper.close();
        else await channel.close();
        throw error;
      }
    }
    const endpoint = await (
      (typeof options.endpoint === "function" ? options.endpoint : undefined) ??
      (() => localFrameEndpoint(options.platform ?? process.platform, options.nextId))
    )();
    try {
      ScreenEndpoint.parse(endpoint.uri);
    } catch (error) {
      await endpoint.close();
      throw error;
    }
    const path = endpoint.path;
    const server = createServer();
    let socket: Socket | undefined;
    let helper: Helper | undefined;
    const decoder = new FrameDecoder(options.onFrame);
    server.on("connection", (candidate) => {
      if (socket || helper?.closed) {
        candidate.destroy();
        return;
      }
      socket = candidate;
      candidate.on("data", (chunk: Buffer) => {
        try {
          decoder.push(chunk);
        } catch (error) {
          helper?.fail(error instanceof Error ? error : new Error("Invalid frame"));
        }
      });
      candidate.on("error", (error) => helper?.fail(error));
      candidate.on("close", () => helper?.fail(new Error("Frame socket closed")));
    });
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen({ path, readableAll: false, writableAll: false }, resolve);
      });
      await endpoint.secure();
      const command = options.prepare ? await options.prepare() : options.command;
      const proc = (options.spawn ?? spawnSupervised)({
        command,
        args: [
          ...(options.args ?? []),
          options.transport === "legacy" ? "--socket" : "--endpoint",
          options.transport === "legacy" ? path : endpoint.uri,
        ],
        env: options.env ?? {},
        name: "screen-helper",
        maxLineBytes: 64 * 1024,
        onOutputLimit: (error) => helper?.fail(error),
      });
      helper = new Helper(
        proc,
        async () => {
          socket?.destroy();
          await new Promise<void>((resolve) => server.close(() => resolve()));
          await endpoint.close();
        },
        options,
      );
      if (options.protocolVersion === 2) {
        try {
          await helper.negotiate();
        } catch (error) {
          await helper.close();
          throw error;
        }
      }
      return helper;
    } catch (error) {
      server.close();
      await endpoint.close();
      throw error;
    }
  }
  async negotiate(): Promise<ScreenCapabilities | undefined> {
    if (this.capabilities) return this.capabilities;
    try {
      const result = await this.request({ op: "hello" });
      // Older v1 helpers return no negotiation data or explicitly reject hello.
      if (result === undefined) return undefined;
      const capabilities = ScreenCapabilities.parse(result);
      if (this.options.expectedPlatform && capabilities.platform !== this.options.expectedPlatform)
        throw new Error("Helper display backend differs from selected backend");
      if (!capabilities.codecs.includes("jpeg"))
        throw new Error("Helper has no supported JPEG codec");
      this.capabilities = capabilities;
      return capabilities;
    } catch (error) {
      if (
        error instanceof Error &&
        (/Unsupported command|not supported/i.test(error.message) ||
          ("code" in error && error.code === "not_supported"))
      )
        return undefined;
      throw error;
    }
  }
  requestV2(
    command: WithoutEnvelope<import("@ace/protocol").ScreenHelperRequestV2>,
  ): Promise<unknown> {
    return this.send(command);
  }
  request(
    command: WithoutEnvelope<ScreenHelperRequest | import("@ace/protocol").ScreenHelperRequestV2>,
  ): Promise<unknown> {
    const result = this.send(command);
    if (command.op !== "permissions" || this.capabilities?.platform !== "windows") return result;
    return result.then((data) => {
      const permissions = ScreenPermissionsV2.parse(data);
      return {
        screenRecording: ["granted", "n/a"].includes(permissions.screen),
        accessibility: ["granted", "n/a"].includes(permissions.input),
      };
    });
  }
  private send(
    command:
      | WithoutEnvelope<ScreenHelperRequest>
      | WithoutEnvelope<import("@ace/protocol").ScreenHelperRequestV2>,
  ): Promise<unknown> {
    if (Buffer.byteLength(JSON.stringify(command)) > 64 * 1024)
      return Promise.reject(new HelperCommandError("bounds", "Helper command exceeds limit"));
    if (this.closed) return Promise.reject(new Error("Helper is closed"));
    if (this.pending.size >= 32) return Promise.reject(new Error("Helper request limit"));
    const windows = (this.options.platform ?? process.platform) === "win32";
    const linux =
      this.options.expectedPlatform?.startsWith("linux") ||
      this.capabilities?.platform.startsWith("linux");
    if (windows && command.op === "capture")
      return this.send({ op: "watch", active: command.enabled });
    if ((windows || linux) && command.op === "input") {
      const { kind, ...input } = command.input;
      return this.send(
        ScreenHelperRequestV2.parse({ op: kind, ...input, version: 2, id: "input" }),
      );
    }
    const request = (
      windows || linux || this.options.protocolVersion === 2
        ? ScreenHelperRequestV2
        : ScreenHelperRequest
    ).parse({
      ...command,
      version:
        windows || linux || this.options.protocolVersion === 2
          ? 2
          : command.op === "hello"
            ? 1
            : this.capabilities
              ? 2
              : 1,
      id: this.options.nextId(),
    });
    const line = `${JSON.stringify(request)}\n`;
    if (Buffer.byteLength(line) > 64 * 1024)
      return Promise.reject(new HelperCommandError("bounds", "Helper command exceeds limit"));
    if (this.pending.has(request.id)) return Promise.reject(new Error("Duplicate request id"));
    return new Promise((resolve, reject) => {
      const cancel = (this.options.scheduler ?? nodeScheduler).schedule(
        () => this.fail(new Error("Helper command timed out")),
        this.options.timeoutMs ??
          (request.op === "start" && this.capabilities?.platform === "linux-wayland"
            ? 130_000
            : 10_000),
      );
      this.pending.set(request.id, { resolve, reject, cancel });
      this.proc.stdin.write(line, (error) => {
        if (error) this.fail(error);
      });
    });
  }
  private fail(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) {
      pending.cancel();
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
        pending.cancel();
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
