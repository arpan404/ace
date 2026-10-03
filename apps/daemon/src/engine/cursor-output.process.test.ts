import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import { Store, Engine, AdapterRegistry, createDevThread } from "@ace/daemon";
import {
  CursorTranslator,
  cursorCapabilities,
  streamSdkBody,
  type CursorEnvelope,
} from "@ace/adapter-cursor";
import { ProviderPayload } from "@ace/provider-kit/payload";
import { Command, ThreadId } from "@ace/protocol";
import type { SessionContext } from "@ace/engine-api";

it("stores megabyte SDK shell output and raw provenance in bounded chunks without killing the turn", async () => {
  const root = await mkdtemp(join(tmpdir(), "cursor-output-"));
  const store = new Store(join(root, "state.sqlite"));
  const registry = new AdapterRegistry(),
    admitted = Promise.withResolvers<SessionContext>();
  const thread = ThreadId.parse("output-thread");
  let seq = 0,
    largest = 0;
  const emit = async (
    context: SessionContext,
    kind: string,
    body: unknown,
    raw?: CursorEnvelope["raw"],
  ) => {
    const envelope: CursorEnvelope = {
      schemaVersion: 1,
      generation: "host",
      operationId: "send",
      segment: 0,
      kind,
      body,
      ...(raw ? { raw } : {}),
    };
    const payload = new ProviderPayload(JSON.stringify(envelope));
    largest = Math.max(largest, payload.bytes);
    await context.onFrame({
      seq: ++seq,
      t: seq,
      dir: "recv",
      channel: "sdk",
      data: payload.data,
      payload,
    });
  };
  registry.register(
    {
      provider: "cursor",
      backend: "cursor-sdk",
      capabilities: () => cursorCapabilities,
      createTranslator: (init) => new CursorTranslator(init),
      async openSession(context) {
        context.onSessionIdentity?.({
          backend: "cursor-sdk",
          instanceId: "fixture",
          nativeSessionId: "native",
        });
        admitted.resolve(context);
        await emit(context, "open", { cwd: root });
        return {
          backend: "cursor-sdk",
          instanceId: "fixture",
          nativeSessionId: "native",
          async send(input) {
            await emit(context, "send", { input });
          },
          async interrupt() {},
          async resolve() {},
          async stopTask() {},
          async close() {},
        };
      },
    },
    { installed: true, auth: "logged_in", loginHint: "offline" },
  );
  const engine = new Engine(store, {
    registry,
    selectInstance: () => "fixture",
    threadId: () => thread,
  });
  try {
    const workspaceId = store.createWorkspace(root, "Fixture");
    expect(
      engine.handler.handle(
        Command.parse({
          id: "send",
          deviceId: "device",
          payload: {
            type: "thread.create",
            workspaceId,
            provider: "cursor",
            input: [{ type: "text", text: "synthetic" }],
          },
        }),
        store,
      ),
    ).toMatchObject({ ok: true });
    await engine.flush();
    const context = await admitted.promise;
    await emit(context, "delta", {
      type: "tool-call-started",
      callId: "shell",
      toolCall: { type: "shell", args: { command: "synthetic output" } },
    });
    const output = "line\n".repeat(209716);
    const other = createDevThread(store, workspaceId);
    const prepared = await streamSdkBody(
      {
        type: "tool-call-completed",
        callId: "shell",
        toolCall: {
          type: "shell",
          result: { status: "success", value: { exitCode: 0, stdout: output, stderr: "" } },
        },
      },
      "host:large",
      async (kind, body) => {
        await emit(context, kind, body);
        if (kind === "blob") expect(() => store.appendRawChunk(other.id, body)).toThrow("scope");
      },
      {},
    );
    // Chunks commit before terminal lifecycle; output is already visible while the tool runs.
    const running = Object.values(store.snapshotThread(thread).items ?? {}).find(
      (item) => item.type === "tool_call",
    );
    expect(running).toMatchObject({
      complete: false,
      call: { status: "running", detail: { output: { bytes: Buffer.byteLength(output) } } },
    });
    await emit(context, "delta", prepared.body, prepared.raw);
    await emit(context, "result", { status: "finished" });
    await engine.flush();
    const view = store.snapshotThread(thread),
      tool = Object.values(view?.items ?? {}).find((item) => item.type === "tool_call");
    expect(view.thread.status.state).toBe("done");
    if (!tool || tool.call.detail.kind !== "shell" || !tool.call.detail.output)
      throw new Error("Missing shell stream");
    const streamId = tool.call.detail.output.streamId;
    const bytes: Uint8Array[] = [];
    for (let offset = 0; offset < Buffer.byteLength(output); offset += 65536)
      bytes.push(store.readOutputBytes(streamId, offset, 65536).bytes);
    expect(Buffer.concat(bytes).toString()).toBe(output);
    if (!prepared.raw) throw new Error("Missing streamed raw reference");
    expect(store.blobInfo(prepared.raw.blobRef)).toMatchObject({
      threadId: thread,
      size: prepared.raw.size,
    });
    const raw: Uint8Array[] = [];
    for (let offset = 0; offset < prepared.raw.size; offset += 65536)
      raw.push(store.readRawChunk(prepared.raw.blobRef, offset, 65536));
    expect(JSON.parse(Buffer.concat(raw).toString()).toolCall.result.value.stdout).toBe(output);
    expect(largest).toBeLessThan(262144);
  } finally {
    await engine.close();
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
