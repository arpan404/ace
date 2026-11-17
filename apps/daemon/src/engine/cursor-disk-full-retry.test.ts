import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { Store, Engine, AdapterRegistry } from "@ace/daemon";
import { CursorTranslator, cursorCapabilities } from "@ace/adapter-cursor";
import { Command } from "@ace/protocol";
import type { SessionContext } from "@ace/engine-api";
import { ProviderPayload } from "@ace/provider-kit/payload";

test("a Cursor batch whose commit fails on a full disk is written whole once space is back, and the next turn continues", async () => {
  const root = await mkdtemp(join(tmpdir(), "cursor-disk-full-"));
  const store = new Store(join(root, "events.sqlite"));
  // The disk boundary: the store's own connection may not grow the file while capped, so the
  // batch's transaction fails with SQLITE_FULL exactly as a full volume makes it fail.
  const disk = store.atomic((db) => db);
  const cap = () =>
    disk.exec(
      `PRAGMA max_page_count=${Number(disk.prepare("PRAGMA page_count").get()?.page_count)}`,
    );
  const lift = () => disk.exec("PRAGMA max_page_count=1073741823");
  const big = "x".repeat(256 * 1024);
  const registry = new AdapterRegistry();
  let turns = 0;
  registry.register(
    {
      provider: "cursor",
      backend: "cursor-sdk",
      capabilities: () => cursorCapabilities,
      createTranslator: (init) => new CursorTranslator(init),
      async openSession(context: SessionContext) {
        context.signal.addEventListener("abort", () => context.onExit({ deliberate: false }), {
          once: true,
        });
        context.onSessionIdentity?.({
          backend: "cursor-sdk",
          instanceId: "fixture",
          nativeSessionId: "pinned-agent",
        });
        let offset = 0;
        let operationId = "open";
        const emit = async (kind: string, body: unknown) => {
          const seq = ++offset;
          const payload = new ProviderPayload(
            JSON.stringify({
              schemaVersion: 1,
              generation: "host-1",
              operationId,
              segment: 0,
              agentId: "pinned-agent",
              kind,
              body,
              boundaryOffset: seq,
            }),
          );
          await context.onFrame({
            seq: seq * 1024,
            t: seq,
            dir: "recv",
            channel: "sdk",
            data: payload.data,
            payload,
          });
        };
        await emit("open", { cwd: root });
        return {
          nativeSessionId: "pinned-agent",
          backend: "cursor-sdk",
          instanceId: "fixture",
          async send(input, _delivery, intent) {
            turns++;
            operationId = intent ?? `send-${turns}`;
            if (turns === 1) {
              cap();
              setTimeout(lift, 400);
            }
            await emit("send", { input });
            await emit("delta", { type: "text-delta", text: turns === 1 ? big : "second" });
            await emit("result", { status: "finished" });
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
  const engine = new Engine(store, { registry });
  try {
    const workspaceId = store.createWorkspace(root, "Fixture");
    const result = engine.handler.handle(
      Command.parse({
        id: "start",
        deviceId: "fixture",
        payload: {
          type: "thread.create",
          workspaceId,
          provider: "cursor",
          input: [{ type: "text", text: "start" }],
        },
      }),
      store,
    );
    const threadId = result.threadId;
    if (!threadId) throw new Error("Missing thread");
    await engine.flush();
    expect(
      engine.handler.handle(
        Command.parse({
          id: "again",
          deviceId: "fixture",
          payload: {
            type: "thread.send",
            threadId,
            delivery: "queue",
            input: [{ type: "text", text: "again" }],
          },
        }),
        store,
      ),
    ).toMatchObject({ ok: true });
    await engine.flush();
    const snapshot = store.snapshotThread(threadId);
    const answers = snapshot.itemOrder
      .map((id) => snapshot.items[id])
      .flatMap((item) =>
        item?.type === "message" && item.role === "assistant"
          ? [item.parts.map((part) => (part.type === "text" ? part.text : "")).join("")]
          : [],
      );
    // The first answer is stored once, whole; the second turn's boundary found no gap.
    expect(answers).toEqual([big, "second"]);
    expect(JSON.stringify(snapshot)).not.toContain("missing commit");
    expect(
      store
        .readEvents({ threadId, afterSeq: 0, limit: 500 })
        .filter((event) => event.payload.type === "run.ended")
        .map((event) => (event.payload.type === "run.ended" ? event.payload.state : undefined)),
    ).toEqual(["completed", "completed"]);
  } finally {
    await engine.close();
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
