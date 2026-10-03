import { rm } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { z } from "zod";
import {
  createCursorAdapter,
  createCursorAccountDriver,
  CursorInstance,
  cursorSdkEnvironment,
  type CursorAdapterOptions,
} from "@ace/adapter-cursor";
import { selectHandoff, renderHandoff } from "@ace/handoff";
import type { ProviderAdapter, ProviderSession, SessionContext } from "@ace/engine-api";
import { ThreadId, type ContentPart } from "@ace/protocol";
import { cursorSdkCapture } from "./providers/cursor-sdk.ts";
import { cursorSdkPlan, CursorSdkApproval } from "./cursor-sdk-plan.ts";
import { CursorSdkEvidence } from "./cursor-sdk-evidence.ts";
import { createWorkspace } from "./workspace.ts";

export { cursorSdkCapture, CursorSdkCaptureHeader } from "./providers/cursor-sdk.ts";
export { cursorSdkPlan, CursorSdkApproval } from "./cursor-sdk-plan.ts";
export { cursorSdkScenarios, cursorSdkRecordingPlan } from "./cursor-sdk-scenarios.ts";

const Request = z.strictObject({
  approval: CursorSdkApproval,
  path: z.string().max(4096).refine(isAbsolute),
  instance: CursorInstance,
  freshFixtureInstance: z.literal(true),
  startedAt: z.iso.datetime(),
  platform: z.string().min(1).max(128),
});
export interface CursorRecordingDependencies {
  signal: AbortSignal;
  now(): number;
  id(): string;
  /** Selected-instance environment only. Keys are inherited, never copied into a request/header. */
  launchEnv: NodeJS.ProcessEnv;
  sdk?: Omit<CursorAdapterOptions, "instance" | "env" | "now" | "operationId" | "policy">;
  /** Only the provider SDK boundary may be substituted in offline tests. */
  adapter?(options: CursorAdapterOptions): ProviderAdapter & { close(): Promise<void> };
  modelCatalog?(instance: CursorInstance, signal: AbortSignal): Promise<unknown>;
  workspace?(label: string): string;
}

/** Explicitly invoked, per-scenario approval-gated orchestration. Never performs SDK login. */
export async function recordCursorSdkScenario(input: unknown, deps: CursorRecordingDependencies) {
  // Parse authorization/setup before creating files, workers or disposable workspaces.
  const request = Request.parse(input),
    plan = cursorSdkPlan(request.approval);
  deps.signal.throwIfAborted();
  if (plan.requiresMcp && !deps.sdk?.mcp)
    throw new Error(
      "This approved SDK scenario requires a thread/instance-scoped MCP lease factory",
    );
  if (plan.policy === "restricted" && deps.sdk?.autoReviewAvailable !== true)
    throw new Error("Restricted SDK recording requires verified Auto-review availability");
  const workspace = (deps.workspace ?? createWorkspace)(`cursor-sdk-${plan.id}`);
  if (!isAbsolute(workspace)) throw new Error("SDK fixture workspace must be absolute");
  let capture: ReturnType<typeof cursorSdkCapture> | undefined;
  let adapter: (ProviderAdapter & { close(): Promise<void> }) | undefined;
  const evidence: CursorSdkEvidence[] = [];
  let session: ProviderSession | undefined, nativeId: string | undefined;
  let current: CursorSdkEvidence | undefined;
  const activeEvidence = () => {
    if (!current) throw new Error("SDK fixture evidence unavailable");
    return current;
  };
  const recording = () => {
    if (!capture) throw new Error("SDK fixture capture unavailable");
    return capture;
  };
  let changed = Promise.withResolvers<void>();
  let providerExited = false,
    failure: unknown;
  let resumed = false,
    forked = false;
  const notify = () => {
    const previous = changed;
    changed = Promise.withResolvers<void>();
    previous.resolve();
  };
  const aborted = () => notify();
  deps.signal.addEventListener("abort", aborted, { once: true });
  const wait = async (accept: () => boolean) => {
    while (!accept()) {
      deps.signal.throwIfAborted();
      if (failure) throw failure;
      if (providerExited) throw new Error("SDK fixture host exited with unresolved evidence");
      await changed.promise;
    }
    deps.signal.throwIfAborted();
    if (failure) throw failure;
  };
  const open = async (threadId: ThreadId, resume?: SessionContext["resume"]) => {
    if (!adapter) throw new Error("SDK fixture adapter unavailable");
    if (!resume) {
      current = new CursorSdkEvidence(
        threadId,
        adapter.createTranslator({ threadId, rootKey: "root" }),
        { next: () => deps.id() },
      );
      evidence.push(current);
    }
    const active = activeEvidence();
    providerExited = false;
    return adapter.openSession({
      threadId,
      cwd: workspace,
      instanceId: request.instance.id,
      model: "composer-2.5",
      env: cursorSdkEnvironment(request.instance, deps.launchEnv),
      runtimePolicy: plan.policy,
      signal: deps.signal,
      ...(resume ? { resume } : {}),
      onSessionIdentity(identity) {
        if (identity.nativeSessionId) nativeId = identity.nativeSessionId;
      },
      async onFrame(frame) {
        try {
          const admitted = active.accept(frame);
          await recording().frame(admitted, threadId);
        } catch (error) {
          failure ??= error;
          // SDK requests must fail their ACK. Session-local notes have no ACK
          // owner; retain failure for the scenario instead of an unhandled rejection.
          if (frame.dir === "recv") throw error;
        } finally {
          notify();
        }
      },
      onExit(exit) {
        if (!exit.deliberate) providerExited = true;
        notify();
      },
    });
  };
  const send = (parts: ContentPart[], delivery: "queue" | "steer" = "queue") => {
    if (!session) throw new Error("SDK fixture session unavailable");
    return session.send(parts, delivery, deps.id());
  };
  try {
    adapter = (deps.adapter ?? createCursorAdapter)({
      ...deps.sdk,
      instance: request.instance,
      env: deps.launchEnv,
      policy: plan.policy,
      now: deps.now,
      operationId: deps.id,
    });
    capture = cursorSdkCapture(
      request.path,
      {
        format: "ace-recording/v1",
        provider: "cursor-sdk",
        cliVersion: "1.0.35",
        sdkVersion: "1.0.35",
        model: "composer-2.5",
        scenario: plan.id,
        sandbox: plan.policy === "restricted",
        instanceId: request.instance.id,
        autoReview: plan.policy === "restricted",
        checkpointExpected: true,
        workspace,
        startedAt: request.startedAt,
        platform: request.platform,
      },
      request.approval,
      { env: deps.launchEnv, home: request.instance.homeDir },
    );
    const models =
      deps.modelCatalog ??
      ((instance: CursorInstance, signal: AbortSignal) =>
        createCursorAccountDriver({
          ...deps.sdk,
          launchEnv: deps.launchEnv,
          stopInstance: async () => {},
        }).models(instance, signal));
    await capture.metadata(await models(request.instance, deps.signal));
    const threadId = ThreadId.parse(deps.id());
    session = await open(threadId);
    const first: ContentPart[] = [
      {
        type: "text",
        text:
          plan.workflow === "fork"
            ? "Read README.md and summarize it in one sentence for a later context handoff."
            : plan.prompt,
      },
    ];
    if (plan.id === "mcp-image")
      first.push({
        type: "image",
        mimeType: "image/png",
        url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=",
      });
    await send(first);
    if (plan.workflow === "interrupt") {
      await wait(() => activeEvidence().toolObserved);
      if (activeEvidence().settled)
        throw new Error("SDK work finished before the interrupt boundary");
      await session.interrupt({ cascade: true });
    } else if (plan.workflow === "steer") {
      await wait(() => activeEvidence().textObserved);
      if (!activeEvidence().state.agents.root?.activeRun)
        throw new Error(
          "SDK root finished before the steering boundary; approve a new attempt separately",
        );
      await send(
        [
          {
            type: "text",
            text: "Replacement instruction: read README.md only and summarize its heading.",
          },
        ],
        "steer",
      );
      await wait(() => activeEvidence().settled);
      const source = activeEvidence();
      const rootRuns = Object.values(source.state.runs).filter(
        (run) => run.agentId === source.state.agents.root?.agent.id,
      );
      if (rootRuns.length !== 1 || source.snapshot().nativeRunIds.length < 2)
        throw new Error("SDK steering did not establish two native segments in one ace run");
    } else {
      if (plan.workflow === "background-followup") {
        await wait(() => activeEvidence().rootEnded);
        await send([
          {
            type: "text",
            text: "Report the background child result when it is observable; disclose uncertainty.",
          },
        ]);
      }
      await wait(() => activeEvidence().settled);
      if (plan.workflow === "resume" || plan.workflow === "fork") {
        const sourceId = session.nativeSessionId;
        await session.close("idle");
        session = undefined;
        if (plan.workflow === "resume") {
          session = await open(threadId, {
            nativeSessionId: sourceId,
            backend: "cursor-sdk",
            instanceId: request.instance.id,
            afterFrameOffset: activeEvidence().lastBoundaryOffset,
          });
          if (session.nativeSessionId !== sourceId)
            throw new Error("SDK checkpoint resume changed its native identity");
          resumed = true;
          await send([
            { type: "text", text: "What was the README first heading from the previous turn?" },
          ]);
        } else {
          const items = Object.values(activeEvidence().state.items);
          const handoff = selectHandoff(
            {
              threadId,
              throughSeq: activeEvidence().throughSeq,
              totalItems: items.length,
              items: items.slice(-200),
              origin: { provider: "cursor", backend: "cursor-sdk" },
            },
            16384,
          );
          session = await open(ThreadId.parse(deps.id()));
          if (session.nativeSessionId === sourceId)
            throw new Error("SDK portable fork reused source identity");
          forked = true;
          await send([{ type: "text", text: `${renderHandoff(handoff)}\n${plan.prompt}` }]);
        }
        await wait(() => activeEvidence().settled);
      }
    }
  } catch (error) {
    failure = error;
  } finally {
    try {
      await session?.close("shutdown");
    } catch (error) {
      failure ??= error;
    }
    try {
      await adapter?.close();
    } catch (error) {
      failure ??= error;
    }
    deps.signal.removeEventListener("abort", aborted);
    const observations = {
      scenario: plan.id,
      model: "composer-2.5",
      sdkVersion: "1.0.35",
      outcome: failure ? "incomplete" : "observed",
      resumed,
      forked,
      nativeId,
      threads: evidence.map((value) => value.snapshot()),
      limitations: [
        "Captured observations require owner review before becoming fixture expectations.",
        "Unknown snapshot/live identity and deeper task content remain evidence, not canonical claims.",
        "Missing background completion or cancellation evidence remains unresolved.",
        "SDK MCP is read-only for the whole host; native caller attribution is unavailable.",
      ],
    };
    try {
      await capture?.analysis(observations);
    } finally {
      try {
        await capture?.close();
      } finally {
        await rm(workspace, { recursive: true, force: true });
      }
    }
  }
  if (failure)
    throw new Error("SDK recording incomplete; do not promote it to a fixture", { cause: failure });
  return {
    namespace: "fixtures/cursor-sdk/1.0.35/composer-2.5",
    scenario: plan.id,
    observations: evidence.map((value) => value.snapshot()),
    resumed,
    forked,
  };
}
