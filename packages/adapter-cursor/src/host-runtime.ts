import type { SDKAgent, Run } from "@cursor/sdk";
import { homedir } from "node:os";
import { boundedJson } from "@ace/provider-kit/ipc";
import { createRedactor } from "@ace/redaction";
import { cursorSdkInjection } from "@ace/mcp-server";
import { checkpointDirectory, checkCheckpointBudget } from "./checkpoints.ts";
import {
  Open,
  Send,
  type CursorEnvelope,
  type OpenOptions,
  type SendOptions,
} from "./contracts.ts";
import { localPolicy } from "./policy.ts";

export type SdkModule = typeof import("@cursor/sdk");
export class HostRuntime {
  private agent: SDKAgent | undefined;
  private run: Run | undefined;
  private completion: Promise<void> | undefined;
  private opening = false;
  private sending = false;
  private options: OpenOptions | undefined;
  private sendOptions: SendOptions | undefined;
  private callbacks = 0;
  private callbackBytes = 0;
  private root: string | undefined;
  private store: InstanceType<SdkModule["JsonlLocalAgentStore"]> | undefined;
  private scrub = createRedactor({ env: { CURSOR_API_KEY: process.env.CURSOR_API_KEY } }, ["text"]);
  private sdk: SdkModule;
  private emit: (frame: CursorEnvelope) => Promise<void>;
  constructor(sdk: SdkModule, emit: (frame: CursorEnvelope) => Promise<void>) {
    this.sdk = sdk;
    this.emit = emit;
  }
  private async frame(
    kind: CursorEnvelope["kind"],
    body: unknown,
    scope = this.sendOptions,
    nativeRun?: Run,
  ): Promise<void> {
    const options = this.options;
    if (!options) return;
    if (++this.callbacks > options.limits.maxCallbacks) {
      this.callbacks--;
      throw new Error("SDK callback backlog exceeded budget");
    }
    let admittedBytes = 0;
    try {
      const encoded = boundedJson(body, Math.min(options.limits.maxFrameBytes - 2048, 262144));
      const encodedBytes = Buffer.byteLength(encoded);
      if (this.callbackBytes + encodedBytes > options.limits.maxPendingBytes)
        throw new Error("SDK callback byte backlog exceeded budget");
      admittedBytes = encodedBytes;
      this.callbackBytes += admittedBytes;
      const safe: unknown = JSON.parse(this.scrub(encoded));
      await this.emit({
        schemaVersion: 1,
        generation: options.generation,
        operationId: scope?.operationId ?? "open",
        ...(scope?.commandId ? { commandId: scope.commandId } : {}),
        segment: scope?.segment ?? 0,
        ...(this.agent ? { agentId: this.agent.agentId } : {}),
        ...(nativeRun ? { runId: nativeRun.id } : {}),
        kind,
        body: safe,
      });
    } finally {
      this.callbacks--;
      this.callbackBytes -= admittedBytes;
    }
  }
  async open(value: unknown): Promise<{ agentId: string }> {
    if (this.opening || this.agent) throw new Error("Host already open");
    this.opening = true;
    try {
      const options = Open.parse(value);
      this.options = options;
      const policy = localPolicy(options.policy, options.autoReviewAvailable);
      const status = await this.sdk.Cursor.auth.status();
      if (process.env.CURSOR_API_KEY === undefined && status.status !== "logged-in")
        throw new Error(
          "Cursor SDK requires separate SDK sign-in or launch-environment authentication",
        );
      this.root = checkpointDirectory(homedir(), options.threadId);
      const checkpoint = await checkCheckpointBudget(this.root, options.limits.maxCheckpointBytes);
      if (!options.nativeSessionId && checkpoint.files !== 0)
        throw new Error(
          "Unclaimed SDK checkpoint; recover its identity or use explicit context handoff",
        );
      this.store = new this.sdk.JsonlLocalAgentStore(this.root);
      this.scrub = createRedactor(
        {
          env: { CURSOR_API_KEY: process.env.CURSOR_API_KEY, ACE_MCP_BEARER: options.mcp?.bearer },
        },
        ["text"],
      );
      const injection = options.mcp ? cursorSdkInjection(options.mcp) : undefined;
      const agentOptions = {
        local: { cwd: options.cwd, store: this.store, ...policy },
        model: { id: options.model ?? "composer-2.5" },
        ...(injection ? { mcpServers: injection.mcpServers } : {}),
      };
      if (options.nativeSessionId?.startsWith("bc-"))
        throw new Error("Cloud continuation is forbidden");
      this.agent = options.nativeSessionId
        ? await this.sdk.Agent.resume(options.nativeSessionId, agentOptions)
        : await this.sdk.Agent.create(agentOptions);
      await this.frame("open", {
        policy: options.policy,
        sdkVersion: "1.0.35",
        resumed: !!options.nativeSessionId,
        cwd: options.cwd,
        model: options.model ?? "composer-2.5",
        deltaSource: true,
      });
      return { agentId: this.agent.agentId };
    } catch {
      await this.frame("error", {
        code: "setup_failed",
        message:
          "Cursor SDK setup failed. Check separate SDK sign-in, checkpoint identity/budget, sandbox helpers and Auto-review availability. Preserve unclaimed checkpoints and use explicit context handoff. Execution was not downgraded.",
      });
      throw new Error("SDK setup failed");
    } finally {
      this.opening = false;
    }
  }
  async send(value: unknown): Promise<{ runId: string }> {
    if (!this.agent || !this.options || !this.root || this.sending || this.completion)
      throw new Error("Host not ready for send");
    const input = Send.parse(value);
    boundedJson(input, this.options.limits.maxInputBytes);
    this.sending = true;
    this.sendOptions = input;
    try {
      await checkCheckpointBudget(this.root, this.options.limits.maxCheckpointBytes);
      await this.frame("send", { input: input.input });
      const texts: string[] = [];
      const images: { url: string }[] = [];
      for (const part of input.input) {
        if (part.type === "text") texts.push(part.text);
        else if (part.type === "image") images.push({ url: part.url });
        else texts.push(`Referenced workspace file: ${part.path}`);
      }
      let segmentRun: Run | undefined;
      segmentRun = await this.agent.send(
        { text: texts.join("\n"), ...(images.length ? { images } : {}) },
        {
          onDelta: async ({ update }) => {
            await this.frame("delta", update, input, segmentRun);
          },
        },
      );
      this.run = segmentRun;
      await this.frame("segment", { nativeRunId: segmentRun.id }, input, segmentRun);
      const run = segmentRun;
      this.completion = this.consume(run, input).finally(() => {
        this.completion = undefined;
        this.run = undefined;
      });
      void this.completion.catch(() => {});
      return { runId: run.id };
    } catch (error) {
      await this.frame("error", {
        ...this.failure(error),
        code: this.failure(error).code ?? "send_uncertain",
        message:
          "SDK send did not establish a run identity. Delivery is uncertain; inspect this thread before submitting again.",
      });
      throw new Error("SDK send uncertain", { cause: error });
    } finally {
      this.sending = false;
    }
  }
  private async consume(run: Run, scope: SendOptions): Promise<void> {
    try {
      for await (const message of run.stream()) await this.frame("message", message, scope, run);
      const result = await run.wait();
      await this.frame("result", result, scope, run);
    } catch (error) {
      try {
        await run.cancel();
      } catch {
        /* Supervised shutdown handles unresolved cancellation. */
      }
      await this.frame(
        "error",
        {
          ...this.failure(error),
          code: this.failure(error).code ?? "runtime_failed",
          message:
            "Cursor SDK run failed or exceeded its transport budget; checkpoint retained. Cancellation and child work may be uncertain.",
        },
        scope,
        run,
      );
      throw new Error("SDK runtime failed", { cause: error });
    }
  }
  private failure(error: unknown): { code?: string; retryable?: boolean } {
    // Only authoritative SDK classes establish these failures; no prose heuristics.
    if (error instanceof this.sdk.AuthenticationError) return { code: "auth" };
    if (error instanceof this.sdk.RateLimitError)
      return { code: "rate_limit", retryable: error.isRetryable };
    if (error instanceof this.sdk.NetworkError)
      return { code: "network", retryable: error.isRetryable };
    return {};
  }
  async cancel(): Promise<void> {
    if (this.sending) throw new Error("Cannot prove cancellation during SDK admission");
    if (!this.run) return;
    await this.run.cancel();
    await this.completion;
    await this.frame("cancel", { settled: true });
  }
  async close(): Promise<void> {
    if (this.run) await this.cancel();
    if (this.agent) await this.agent[Symbol.asyncDispose]();
    await this.frame("close", { disposed: true });
    this.agent = undefined;
  }
}
