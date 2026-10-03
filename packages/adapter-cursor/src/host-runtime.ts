import { ShellStreams } from "./shell-streams.ts";
import { streamSdkBody } from "./body-stream.ts";
import type { LocalAgentStore } from "@cursor/sdk";
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
import { openSdkCheckpointStore, checkpointRevision } from "./sdk-store.ts";
import { CheckpointQuota } from "./checkpoint-quota.ts";
import { boundedCheckpointStore } from "./checkpoint-store.ts";
import { CursorJournal } from "./journal.ts";
import { recoverCursorCheckpoint } from "./recovery.ts";
import { localPolicy } from "./policy.ts";
import { sdkFailure } from "./sdk-failure.ts";

export type { SdkModule } from "./runtime-boundary.ts";
import type { RuntimeSdkBoundary, SdkAgentBoundary, SdkRunBoundary } from "./runtime-boundary.ts";
export class HostRuntime {
  private agent: SdkAgentBoundary | undefined;
  private run: SdkRunBoundary | undefined;
  private completion: Promise<void> | undefined;
  private opening = false;
  private closing: Promise<void> | undefined;
  private sending = false;
  private options: OpenOptions | undefined;
  private sendOptions: SendOptions | undefined;
  private callbacks = 0;
  private bodyId = 0;
  private shellStreams: ShellStreams | undefined;
  private transportFenced = false;
  private callbackBytes = 0;
  private root: string | undefined;
  private journal: CursorJournal | undefined;
  private store: LocalAgentStore | undefined;
  private storeOwner: Awaited<ReturnType<typeof openSdkCheckpointStore>> | undefined;
  private scrub = createRedactor({ env: { CURSOR_API_KEY: process.env.CURSOR_API_KEY } }, ["text"]);
  private sdk: RuntimeSdkBoundary;
  private emit: (frame: CursorEnvelope) => Promise<void>;
  private home: () => string;
  constructor(
    sdk: RuntimeSdkBoundary,
    emit: (frame: CursorEnvelope) => Promise<void>,
    home = homedir,
  ) {
    this.home = home;
    this.sdk = sdk;
    this.emit = emit;
  }
  private async frame(
    kind: CursorEnvelope["kind"],
    body: unknown,
    scope = this.sendOptions,
    nativeRun?: SdkRunBoundary,
  ): Promise<void> {
    const options = this.options;
    if (!options) return;
    if (this.transportFenced) throw new Error("SDK boundary transport is fenced");
    if (++this.callbacks > options.limits.maxCallbacks) {
      this.callbacks--;
      await this.overflow(scope);
      throw new Error("SDK callback backlog exceeded budget");
    }
    let admittedBytes = 0;
    try {
      const prepared = !["blob", "shell-output", "delta-chunk", "error"].includes(kind)
        ? await streamSdkBody(
            body,
            `${options.generation}:${++this.bodyId}`,
            (partKind, part) => this.frame(partKind, part, scope, nativeRun),
            {
              env: {
                CURSOR_API_KEY: process.env.CURSOR_API_KEY,
                ACE_MCP_BEARER: options.mcp?.bearer,
              },
            },
            16777216,
            this.shellStreams,
            `${options.generation}:${scope?.operationId}:${scope?.segment}`,
            options.limits.maxFrameBytes,
          )
        : { body };
      const encoded = boundedJson(
        prepared.body,
        Math.min(options.limits.maxFrameBytes - 2048, 262144),
      );
      const encodedBytes = Buffer.byteLength(encoded);
      if (this.callbackBytes + encodedBytes > options.limits.maxPendingBytes)
        throw new Error("SDK callback byte backlog exceeded budget");
      admittedBytes = encodedBytes;
      this.callbackBytes += admittedBytes;
      const safe: unknown = JSON.parse(this.scrub(encoded));
      const envelope: CursorEnvelope = {
        schemaVersion: 1,
        generation: options.generation,
        operationId: scope?.operationId ?? "open",
        ...(scope?.commandId ? { commandId: scope.commandId } : {}),
        segment: scope?.segment ?? 0,
        ...(this.agent ? { agentId: this.agent.agentId } : {}),
        ...(nativeRun ? { runId: nativeRun.id } : {}),
        kind,
        body: safe,
        ...(prepared.raw ? { raw: prepared.raw } : {}),
      };
      await this.emit(this.journal ? await this.journal.append(envelope) : envelope);
    } catch (error) {
      await this.overflow(scope);
      throw error;
    } finally {
      this.callbacks--;
      this.callbackBytes -= admittedBytes;
    }
  }
  private async overflow(scope: SendOptions | undefined): Promise<void> {
    if (this.transportFenced || !this.options) return;
    this.transportFenced = true;
    // A failed journal/oversized callback cannot carry its own failure. This small
    // emergency frame fences the parent, which owns cancellation and process exit.
    await this.emit({
      schemaVersion: 1,
      generation: this.options.generation,
      operationId: scope?.operationId ?? "open",
      segment: scope?.segment ?? 0,
      kind: "error",
      body: {
        code: "boundary_overflow",
        message:
          "SDK boundary or recovery budget failed. Execution is fenced; checkpoint retained. Inspect delivery before sending again or use bounded context handoff.",
      },
    });
  }
  async open(value: unknown): Promise<{ agentId: string }> {
    if (this.opening || this.agent || this.closing) throw new Error("Host already open or closing");
    this.opening = true;
    try {
      const options = Open.parse(value);
      this.options = options;
      this.shellStreams = new ShellStreams(options.limits.maxIdentities);
      const policy = localPolicy(options.policy, options.autoReviewAvailable);
      if (process.env.CURSOR_API_KEY === "")
        throw new Error("Empty Cursor SDK environment authentication override");
      const status = await this.sdk.Cursor.auth.status();
      if (process.env.CURSOR_API_KEY === undefined && status.status !== "logged-in")
        throw new Error(
          "Cursor SDK requires separate SDK sign-in or launch-environment authentication",
        );
      this.root = checkpointDirectory(this.home(), options.threadId);
      const checkpoint = await checkCheckpointBudget(this.root, options.limits.maxCheckpointBytes);
      if (checkpoint.bytes > options.limits.maxCheckpointBytes)
        throw new Error("SDK checkpoint exceeds budget");
      this.storeOwner = await openSdkCheckpointStore(
        this.sdk,
        this.root,
        options.cwd,
        options.limits.maxCheckpointBytes,
      );
      const quota = new CheckpointQuota(this.root, options.limits.maxCheckpointBytes);
      this.store = boundedCheckpointStore(
        this.storeOwner.store,
        this.root,
        options.limits.maxCheckpointBytes,
        () =>
          this.frame("error", {
            code: "checkpoint_budget",
            message:
              "SDK checkpoint write failed or exceeded budget. Execution is fenced; preserve this thread and use explicit bounded context handoff.",
          }),
        quota,
      );
      const journal = new CursorJournal(
        this.root,
        options.limits.maxCheckpointBytes,
        options.limits.maxFrameBytes,
        {
          maxIdentities: options.limits.maxIdentities,
          maxPendingBytes: options.limits.maxPendingBytes,
          maxCallbacks: options.limits.maxCallbacks,
          quota,
        },
      );
      await journal.recover(options.afterFrameOffset, (frame) => this.emit(frame));
      this.journal = journal;
      let recoveryBytes = 0;
      this.scrub = createRedactor(
        {
          env: { CURSOR_API_KEY: process.env.CURSOR_API_KEY, ACE_MCP_BEARER: options.mcp?.bearer },
        },
        ["text"],
      );
      const recovered: {
        kind: string;
        body: unknown;
        raw?: CursorEnvelope["raw"];
        runId?: string;
        observeOffset?: string;
      }[] = [];
      const nativeId = await recoverCursorCheckpoint(
        this.sdk,
        this.store,
        options,
        async (kind, body, runId, observeOffset) => {
          if (recovered.length >= options.limits.maxIdentities)
            throw new Error("SDK recovery metadata exceeds budget");
          const prepared = await streamSdkBody(
            body,
            `${options.generation}:recovery:${++this.bodyId}`,
            (partKind, part) => this.frame(partKind, part),
            {
              env: {
                CURSOR_API_KEY: process.env.CURSOR_API_KEY,
                ACE_MCP_BEARER: options.mcp?.bearer,
              },
            },
            16777216,
            this.shellStreams,
            "recovery",
            options.limits.maxFrameBytes,
          );
          const encoded = boundedJson(
            prepared.body,
            Math.min(262144, options.limits.maxFrameBytes - 2048),
          );
          recoveryBytes += Buffer.byteLength(encoded);
          if (recoveryBytes > options.limits.maxPendingBytes)
            throw new Error("SDK recovery metadata bytes exceed budget");
          const safe: unknown = JSON.parse(this.scrub(encoded));
          recovered.push({
            kind,
            body: safe,
            ...(prepared.raw ? { raw: prepared.raw } : {}),
            ...(runId ? { runId } : {}),
            ...(observeOffset ? { observeOffset } : {}),
          });
        },
        (runId) => journal.afterObserve(runId),
      );
      const injection = options.mcp ? cursorSdkInjection(options.mcp) : undefined;
      const agentOptions = {
        local: { cwd: options.cwd, store: this.store, ...policy },
        model: { id: options.model ?? "composer-2.5" },
        ...(injection ? { mcpServers: injection.mcpServers } : {}),
      };
      if (nativeId?.startsWith("bc-")) throw new Error("Cloud continuation is forbidden");
      if (nativeId) await checkpointRevision(this.store, nativeId);
      this.agent = nativeId
        ? await this.sdk.Agent.resume(nativeId, agentOptions)
        : await this.sdk.Agent.create(agentOptions);
      await this.frame("open", {
        policy: options.policy,
        sdkVersion: "1.0.35",
        resumed: !!nativeId,
        cwd: options.cwd,
        model: options.model ?? "composer-2.5",
        deltaSource: true,
        checkpointStore: this.storeOwner.kind,
      });
      for (const recovery of recovered) {
        const body = JSON.parse(this.scrub(boundedJson(recovery.body, 262144)));
        await this.emit(
          await journal.append({
            schemaVersion: 1,
            generation: options.generation,
            operationId: "open",
            segment: 0,
            agentId: this.agent.agentId,
            ...recovery,
            body,
          }),
        );
      }
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
    if (
      !this.agent ||
      !this.options ||
      !this.root ||
      this.sending ||
      this.completion ||
      this.closing ||
      this.transportFenced
    )
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
      let segmentRun: SdkRunBoundary | undefined;
      segmentRun = await this.agent.send(
        { text: texts.join("\n"), ...(images.length ? { images } : {}) },
        {
          idempotencyKey: `${input.commandId ?? input.operationId}:${input.segment}`,
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
      const failure = sdkFailure(this.sdk, error);
      await this.frame("error", {
        ...failure,
        code: failure.code ?? "send_uncertain",
        message:
          "SDK send did not establish a run identity. Delivery is uncertain; inspect this thread before submitting again.",
      });
      throw new Error("SDK send uncertain", { cause: error });
    } finally {
      this.sending = false;
    }
  }
  private async consume(run: SdkRunBoundary, scope: SendOptions): Promise<void> {
    try {
      for await (const message of run.stream()) await this.frame("message", message, scope, run);
      const result = await run.wait();
      await this.frame("result", result, scope, run);
    } catch (error) {
      const failure = sdkFailure(this.sdk, error);
      try {
        await run.cancel();
      } catch {
        /* Supervised shutdown handles unresolved cancellation. */
      }
      await this.frame(
        "error",
        {
          ...failure,
          code: failure.code ?? "runtime_failed",
          message:
            "Cursor SDK run failed or exceeded its transport budget; checkpoint retained. Cancellation and child work may be uncertain.",
        },
        scope,
        run,
      );
      throw new Error("SDK runtime failed", { cause: error });
    }
  }
  async cancel(): Promise<void> {
    if (this.sending) throw new Error("Cannot prove cancellation during SDK admission");
    if (!this.run) return;
    await this.run.cancel();
    await this.completion;
    await this.frame("cancel", { settled: true });
  }
  close(): Promise<void> {
    this.closing ??= this.dispose();
    return this.closing;
  }
  private async dispose(): Promise<void> {
    try {
      try {
        if (this.run) await this.cancel();
      } finally {
        if (this.agent) await this.agent[Symbol.asyncDispose]();
      }
      await this.frame("close", { disposed: true });
    } finally {
      try {
        await this.journal?.close();
      } finally {
        await this.storeOwner?.close();
      }
      this.storeOwner = undefined;
      this.agent = undefined;
    }
  }
}
