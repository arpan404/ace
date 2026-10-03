import * as sdk from "@cursor/sdk";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { apply, createThreadState, deriveThreadStatus } from "@ace/core";
import { ThreadId } from "@ace/protocol";
import { ProviderPayload } from "@ace/provider-kit/payload";
import {
  HostRuntime,
  CursorTranslator,
  CursorLimitsSchema,
  type RuntimeSdkBoundary,
  type SdkRunBoundary,
} from "./index.ts";

it("the SDK host admits large normal tool results through blobs and output chunks before bounded IPC", async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), "cursor-large-host-")));
  const terminal = Promise.withResolvers<void>(),
    output = "line\n".repeat(209716);
  const threadId = ThreadId.parse("large-host"),
    state = createThreadState({ threadId, config: { provider: "cursor", silenceMs: 90000 } }),
    translator = new CursorTranslator({ threadId, rootKey: "root" });
  let seq = 0,
    id = 0,
    largest = 0,
    disposed = false;
  const run: SdkRunBoundary = {
    id: "run",
    async *stream() {
      await terminal.promise;
      yield* [];
    },
    async wait() {
      return { id: "run", status: "finished" };
    },
    async cancel() {
      terminal.resolve();
    },
  };
  const agent = {
    agentId: "agent",
    async [Symbol.asyncDispose]() {
      disposed = true;
    },
    async send(...args: Parameters<import("./index.ts").SdkAgentBoundary["send"]>) {
      const options = args[1];
      for (const update of [
        {
          type: "tool-call-started",
          callId: "shell",
          toolCall: { type: "shell", args: { command: "synthetic" } },
        },
        {
          type: "tool-call-completed",
          callId: "shell",
          toolCall: {
            type: "shell",
            args: { command: "synthetic" },
            result: {
              status: "success",
              value: { exitCode: 0, stdout: output, stderr: "", signal: "", executionTime: 1 },
            },
          },
        },
      ])
        await options?.onDelta?.({
          update: sdk.InteractionUpdateSchema.parse({ ...update, modelCallId: "model-call" }),
        });
      return run;
    },
  };
  const boundary: RuntimeSdkBoundary = {
    ...sdk,
    Cursor: {
      ...sdk.Cursor,
      auth: {
        ...sdk.Cursor.auth,
        async status() {
          return { status: "logged-in", backendUrl: "https://synthetic.invalid" };
        },
      },
    },
    Agent: {
      async create() {
        return agent;
      },
      async resume() {
        throw new Error("Fresh thread must not resume");
      },
      async cancelRun() {
        throw new Error("No crash-live run exists");
      },
    },
  };
  const host = new HostRuntime(
    boundary,
    async (envelope) => {
      const payload = new ProviderPayload(JSON.stringify(envelope));
      largest = Math.max(largest, payload.bytes);
      for (const fact of translator.translate(
        { seq: ++seq, t: seq, dir: "recv", channel: "sdk", data: payload.data, payload },
        seq,
      ))
        apply(state, fact, { now: seq, ids: { next: (kind) => `${kind}-${++id}` } });
    },
    () => home,
  );
  try {
    await host.open({
      threadId,
      cwd: home,
      generation: "host",
      policy: "full-access",
      autoReviewAvailable: false,
      limits: CursorLimitsSchema.parse({}),
    });
    await host.send({
      operationId: "operation",
      segment: 0,
      commandId: "command",
      input: [{ type: "text", text: "synthetic" }],
    });
    expect(Object.values(state.items).find((item) => item.type === "tool_call")).toMatchObject({
      complete: true,
      call: { status: "succeeded", detail: { output: { bytes: Buffer.byteLength(output) } } },
    });
    expect(largest).toBeLessThan(262144);
    await host.close();
    expect(disposed).toBe(true);
    expect(deriveThreadStatus(state).state).toBe("done");
  } finally {
    terminal.resolve();
    await host.close();
    await rm(home, { recursive: true, force: true });
  }
});
