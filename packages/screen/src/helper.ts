import { mkdtemp, chmod, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Socket } from "node:net";
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
} from "@ace/protocol";
import { FrameDecoder, type Frame } from "./frames.ts";

export type HelperOptions = {
  command: string;
  protocolVersion?: 1 | 2;
  expectedPlatform?: ScreenCapabilities["platform"];
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
  private readonly proc: SupervisedProcess;
  private readonly cleanup: () => Promise<void>;
  private readonly options: HelperOptions;
  capabilities: ScreenCapabilities | undefined;
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
        const value: unknown = JSON.parse(line);
        const reply =
          this.options.protocolVersion === 2
            ? ScreenHelperReplyV2.parse(value)
            : ScreenHelperReply.parse(value);
        this.recent.push(reply);
        if (this.recent.length > 16) this.recent.shift();
        const pending = this.pending.get(reply.id);
        if (!pending) return;
        this.pending.delete(reply.id);
        clearTimeout(pending.timer);
        if (reply.ok) pending.resolve(reply.data);
        else
          pending.reject(
            new Error(
              typeof reply.error === "string"
                ? reply.error
                : (reply.error?.message ?? "Helper rejected command"),
            ),
          );
      } catch (error) {
        this.fail(error instanceof Error ? error : new Error("Invalid helper reply"));
      }
    });
    void proc.exited.then(() => this.fail(new Error("Screen helper exited")));
  }
  static async open(options: HelperOptions): Promise<Helper> {
    const directory = await mkdtemp(join(tmpdir(), "ace-screen-"));
    await chmod(directory, 0o700);
    const path = join(directory, "frames.sock");
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
        server.listen(path, resolve);
      });
      await chmod(path, 0o600);
      const proc = (options.spawn ?? spawnSupervised)({
        command: options.command,
        args: [
          ...(options.args ?? []),
          ...(options.protocolVersion === 2 ? ["--endpoint", `unix:${path}`] : ["--socket", path]),
        ],
        env: options.env ?? {},
        name: "screen-helper",
      });
      helper = new Helper(
        proc,
        async () => {
          socket?.destroy();
          await new Promise<void>((resolve) => server.close(() => resolve()));
          await rm(directory, { recursive: true, force: true });
        },
        options,
      );
      if (options.protocolVersion === 2) {
        try {
          const capabilities = ScreenCapabilities.parse(await helper.request({ op: "hello" }));
          if (options.expectedPlatform && capabilities.platform !== options.expectedPlatform)
            throw new Error("Helper display backend differs from selected backend");
          if (!capabilities.codecs.includes("jpeg"))
            throw new Error("Helper has no supported JPEG codec");
          helper.capabilities = capabilities;
        } catch (error) {
          await helper.close();
          throw error;
        }
      }
      return helper;
    } catch (error) {
      server.close();
      await rm(directory, { recursive: true, force: true });
      throw error;
    }
  }
  request(command: WithoutEnvelope<ScreenHelperRequest | ScreenHelperRequestV2>): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error("Helper is closed"));
    if (this.pending.size >= 32) return Promise.reject(new Error("Helper request limit"));
    const schema = this.options.protocolVersion === 2 ? ScreenHelperRequestV2 : ScreenHelperRequest;
    const request = schema.parse({
      ...command,
      version: this.options.protocolVersion ?? 1,
      id: this.options.nextId(),
    });
    const line = `${JSON.stringify(request)}\n`;
    if (Buffer.byteLength(line) > 64 * 1024)
      return Promise.reject(new Error("Helper command exceeds limit"));
    if (this.pending.has(request.id)) return Promise.reject(new Error("Duplicate request id"));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => this.fail(new Error("Helper command timed out")),
        this.options.timeoutMs ??
          (request.op === "start" && this.capabilities?.platform === "linux-wayland"
            ? 130_000
            : 10_000),
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
