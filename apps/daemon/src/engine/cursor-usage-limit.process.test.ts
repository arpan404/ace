import { expect, test } from "vitest";
import { CursorTranslator, cursorCapabilities } from "@ace/adapter-cursor";
import { ProviderPayload } from "@ace/provider-kit/payload";
import type { ProviderAdapter, SessionContext } from "@ace/engine-api";
import { harness, scriptFrames } from "./test-support.ts";

// What Cursor's SDK reported to the owner when the account ran out of usage, verbatim.
const outOfUsage =
  "Increase limits for faster responses You're out of usage. Switch to Auto, or ask your admin to increase your limit to continue.";

/** Cursor at its SDK boundary: every turn ends in the provider error it is given. */
function cursorFailing(message: string): ProviderAdapter {
  let offset = 0;
  const emit = async (context: SessionContext, kind: string, body: unknown) => {
    const payload = new ProviderPayload(
      JSON.stringify({
        schemaVersion: 1,
        generation: "generation",
        operationId: "turn-1",
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
  return {
    provider: "cursor",
    backend: "cursor-sdk",
    capabilities: () => cursorCapabilities,
    createTranslator: (init) => new CursorTranslator(init),
    async openSession(context) {
      await emit(context, "open", { cwd: context.cwd });
      return {
        backend: "cursor-sdk",
        nativeSessionId: "native",
        async send(input) {
          await emit(context, "send", { input });
          await emit(context, "error", { settled: true, message });
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
}

test("Cursor running out of usage is a usage limit that asks for another model, not a failed turn", async () => {
  const h = await harness([], scriptFrames(), {
    provider: "cursor",
    capabilities: cursorCapabilities,
    nativeAdapter: cursorFailing(outOfUsage),
  });
  try {
    const id = await h.create();
    const view = h.store.snapshotThread(id);
    const notice = Object.values(view.items).find(
      (item) => item.type === "notice" && item.level === "error",
    );
    expect(notice).toMatchObject({
      code: "model_quota",
      title: "Usage limit reached",
      text: expect.stringContaining("Choose another model (Cursor suggests Auto)"),
      // The provider's own words stay behind Details, where they were already shown.
      detail: outOfUsage,
    });
    expect(view.thread.status.state).toBe("limited");
    expect(Object.values(view.agents)).toContainEqual(
      expect.objectContaining({ status: expect.objectContaining({ state: "blocked" }) }),
    );
  } finally {
    await h.close();
  }
});

test("other Cursor failures stay failed turns with the provider's words", async () => {
  const h = await harness([], scriptFrames(), {
    provider: "cursor",
    capabilities: cursorCapabilities,
    nativeAdapter: cursorFailing('AI Model Not Found Invalid parameters for registry model: "x"'),
  });
  try {
    const id = await h.create();
    const view = h.store.snapshotThread(id);
    expect(view.thread.status.state).toBe("failed");
    expect(Object.values(view.items)).toContainEqual(
      expect.objectContaining({ type: "notice", code: "cursor.run-failed" }),
    );
  } finally {
    await h.close();
  }
});
