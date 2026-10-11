import { expect, test } from "vitest";
import { CursorTranslator, cursorCapabilities } from "@ace/adapter-cursor";
import { ProviderPayload } from "@ace/provider-kit/payload";
import type { ProviderAdapter, SessionContext } from "@ace/engine-api";
import { harness, scriptFrames } from "./test-support.ts";
import { Engine, Store } from "@ace/daemon";

function provider() {
  let offset = 0,
    operation = 0;
  const contexts: SessionContext[] = [];
  const emit = async (context: SessionContext, kind: string, body: unknown) => {
    const payload = new ProviderPayload(
      JSON.stringify({
        schemaVersion: 1,
        generation: "generation",
        operationId: `turn-${operation}`,
        segment: 0,
        boundaryOffset: ++offset,
        kind,
        body,
      }),
    );
    await context.onFrame({
      seq: offset,
      t: offset,
      dir: "recv",
      channel: "sdk",
      payload,
      data: payload.data,
    });
  };
  const adapter: ProviderAdapter = {
    provider: "cursor",
    backend: "cursor-sdk",
    capabilities: () => cursorCapabilities,
    createTranslator: (init) => new CursorTranslator(init),
    async openSession(context) {
      contexts.push(context);
      await emit(context, "open", { cwd: context.cwd });
      return {
        backend: "cursor-sdk",
        nativeSessionId: "native",
        async send(input) {
          operation++;
          await emit(context, "send", { input });
          await emit(context, "delta", { type: "text-delta", text: `answer-${operation}` });
          await emit(context, "result", { status: "finished" });
        },
        async interrupt() {},
        async resolve() {},
        async stopTask() {},
        async close() {
          context.onExit({ deliberate: true });
        },
      };
    },
  };
  return { adapter, contexts, emit };
}

test("settled SDK turns discard old provenance and resume with the latest turn's identity", async () => {
  const p = provider();
  const h = await harness([], scriptFrames(), {
    provider: "cursor",
    capabilities: cursorCapabilities,
    nativeAdapter: p.adapter,
  });
  let resumed: Engine | undefined, store: Store | undefined;
  try {
    const id = await h.create();
    const context = p.contexts[0];
    if (!context) throw new Error("No provider");
    for (let i = 0; i < 20; i++) await p.emit(context, "observe", { padding: "x".repeat(900_000) });
    await h.engine.flush();
    await h.engine.close();
    store = new Store(h.path);
    resumed = new Engine(store, { registry: h.registry, clock: h.clock });
    await resumed.flush();
    const { Command } = await import("@ace/protocol");
    const second = Command.parse({
      id: "second-send",
      deviceId: "device",
      payload: {
        type: "thread.send",
        threadId: id,
        input: [{ type: "text", text: "second" }],
        delivery: "queue",
      },
    });
    const engine = resumed,
      opened = store;
    opened.recordCommand(second.id, second.deviceId, () => engine.handler.handle(second, opened));
    await resumed.flush();
    const retained = store
      .statement("SELECT SUM(length(frame)) AS bytes FROM engine_provider_frames WHERE thread_id=?")
      .get(id);
    expect(Number(retained?.bytes)).toBeLessThan(100_000);
    const command = {
      id: "third-send",
      deviceId: "device",
      payload: {
        type: "thread.send",
        threadId: id,
        input: [{ type: "text", text: "third" }],
        delivery: "queue",
      },
    };
    const parsed = Command.parse(command);
    store.recordCommand(
      parsed.id,
      parsed.deviceId,
      () =>
        resumed?.handler.handle(parsed, store ?? h.store) ?? { commandId: parsed.id, ok: false },
    );
    await resumed.flush();
    const messages = Object.values(store.snapshotThread(id).items).filter(
      (item) => item.type === "message" && item.role === "assistant",
    );
    expect(messages.map((item) => (item.type === "message" ? item.parts : []))).toEqual([
      [{ type: "text", text: "answer-1" }],
      [{ type: "text", text: "answer-2" }],
      [{ type: "text", text: "answer-3" }],
    ]);
  } finally {
    await resumed?.close();
    store?.close();
    await h.close();
  }
});
