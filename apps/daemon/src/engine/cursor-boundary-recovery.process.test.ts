import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { Store, Engine, AdapterRegistry } from "@ace/daemon";
import { CursorTranslator, cursorCapabilities } from "@ace/adapter-cursor";
import { Command } from "@ace/protocol";
import type { SessionContext } from "@ace/engine-api";
import { ProviderPayload } from "@ace/provider-kit/payload";

it.each(["boundary_overflow", "checkpoint_budget", "identity_overflow"])(
  "validates explicit Cursor continuation after %s while retaining translator overflow fences",
  async (failure) => {
    const root = await mkdtemp(join(tmpdir(), "cursor-boundary-recovery-"));
    const store = new Store(join(root, "events.sqlite"));
    const registry = new AdapterRegistry();
    let opened = 0;
    let offset = 0;
    registry.register(
      {
        provider: "cursor",
        backend: "cursor-sdk",
        capabilities: () => cursorCapabilities,
        createTranslator: (init) => new CursorTranslator(init),
        async openSession(context: SessionContext) {
          const generation = `host-${++opened}`;
          context.signal.addEventListener("abort", () => context.onExit({ deliberate: false }), {
            once: true,
          });
          if (opened > 1) expect(context.resume?.nativeSessionId).toBe("pinned-agent");
          context.onSessionIdentity?.({
            backend: "cursor-sdk",
            instanceId: "fixture",
            nativeSessionId: "pinned-agent",
          });
          let operationId = "open";
          const emit = async (kind: string, body: unknown, durable = true) => {
            const seq = ++offset;
            const payload = new ProviderPayload(
              JSON.stringify({
                schemaVersion: 1,
                generation,
                operationId,
                segment: 0,
                agentId: "pinned-agent",
                kind,
                body,
                ...(durable ? { boundaryOffset: seq } : {}),
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
              operationId = intent ?? "send";
              await emit("send", { input });
              if (opened === 1) {
                if (failure === "identity_overflow") {
                  await emit("delta", {
                    type: "tool-call-started",
                    callId: "x".repeat(513),
                    toolCall: { type: "mcp" },
                  });
                } else {
                  await emit("delta", {
                    type: "tool-call-started",
                    callId: "screenshot",
                    toolCall: {
                      type: "mcp",
                      args: {
                        providerIdentifier: "ace",
                        toolName: "browser_screenshot",
                        args: {},
                      },
                    },
                  });
                  await emit("error", { code: failure, message: "Checkpoint retained" }, false);
                  offset--; // Emergency fences are not entries in the durable SDK journal.
                }
              } else {
                await emit("delta", { type: "text-delta", text: "continued" });
                await emit("result", { status: "finished" });
              }
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
      if (!result.threadId) throw new Error("Missing thread");
      await engine.flush();
      expect(store.getThread(result.threadId)?.status.state).not.toBe("done");
      expect(
        engine.handler.handle(
          Command.parse({
            id: "continue",
            deviceId: "fixture",
            payload: {
              type: "thread.send",
              threadId: result.threadId,
              delivery: "queue",
              input: [{ type: "text", text: "continue" }],
            },
          }),
          store,
        ),
      ).toMatchObject({ ok: true });
      await engine.flush();
      if (failure === "identity_overflow") {
        expect(opened).toBe(1);
        expect(store.getThread(result.threadId)?.status.state).not.toBe("done");
        expect(JSON.stringify(store.snapshotThread(result.threadId))).toContain(
          "SDK translation provenance is fenced",
        );
        return;
      }
      expect(opened).toBe(2);
      const snapshot = store.snapshotThread(result.threadId);
      expect(snapshot.itemOrder.map((id) => snapshot.items[id])).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "message",
            role: "assistant",
            parts: [{ type: "text", text: "continued" }],
          }),
        ]),
      );
      expect(
        store
          .readEvents({ threadId: result.threadId, afterSeq: 0, limit: 200 })
          .findLast((event) => event.payload.type === "run.ended")?.payload,
      ).toMatchObject({
        type: "run.ended",
        state: "completed",
      });
      // The replacement finishes, but the screenshot lost with the old host remains uncertain.
      expect(store.getThread(result.threadId)?.status.state).toBe("waiting");
    } finally {
      await engine.close();
      store.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);
