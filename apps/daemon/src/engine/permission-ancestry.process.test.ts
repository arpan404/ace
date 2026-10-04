import { expect, test } from "vitest";
import { Engine, Store } from "@ace/daemon";
import { Command, ThreadId, type CommandPayload } from "@ace/protocol";
import { harness, scriptFrames, start, end } from "./test-support.ts";
import { transitionHarness } from "./transition-test-support.ts";

test.each([false, true])(
  "idle intermediates cannot hide a tightened ancestor from turns, setters or spawns after cold restart: %s",
  async (coldRestart) => {
    const frames = scriptFrames();
    const h = await harness([{ on: "send", frames: [frames.frame(start, end)] }], frames, {
      permissionSettings: async () => "full-access",
    });
    let engine = h.engine;
    let store = h.store;
    let commandNumber = 0;
    const command = (payload: CommandPayload) => {
      const request = Command.parse({
        id: `ancestry-${commandNumber++}`,
        deviceId: "device",
        payload,
      });
      return store.recordCommand(request.id, request.deviceId, () =>
        engine.handler.handle(request, store),
      );
    };
    try {
      const ancestor = await h.create();
      const spawn = (name: string, parent: ThreadId, permissionMode?: "full-access") =>
        engine.spawn(
          Command.parse({
            id: `spawn-${name}`,
            deviceId: "host",
            payload: {
              type: "thread.prepare",
              threadId: name,
              workspaceId: h.workspace,
              title: name,
              provider: "codex",
            },
          }),
          { parentThreadId: parent, ...(permissionMode ? { permissionMode } : {}) },
        );
      const middle = spawn("middle", ancestor).threadId;
      if (!middle) throw new Error("Missing middle");
      const descendant = spawn("descendant", middle).threadId;
      if (!descendant) throw new Error("Missing descendant");
      const send = async (id: ThreadId) => {
        expect(
          command({ type: "thread.send", threadId: id, input: [{ type: "text", text: "next" }] })
            .ok,
        ).toBe(true);
        await engine.flush();
      };
      await send(middle);
      await send(descendant);
      expect(h.contexts.at(-1)?.permissionMode).toBe("full-access");
      expect(
        command({ type: "thread.permission.set", threadId: ancestor, permissionMode: "read-only" })
          .ok,
      ).toBe(true);
      await send(ancestor);
      expect(engine.permissionMode(ancestor)).toBe("read-only");
      if (coldRestart) {
        await engine.close();
        await store.close();
        store = new Store(h.path);
        engine = new Engine(store, {
          registry: h.registry,
          clock: h.clock,
          permissionSettings: async () => "full-access",
        });
        await engine.flush();
        expect(engine.permissionMode(ancestor)).toBe("read-only");
      }
      // The middle's previous turn remains pinned; admission must traverse past it.
      expect(engine.permissionMode(middle)).toBe("full-access");
      expect(
        command({
          type: "thread.permission.set",
          threadId: descendant,
          permissionMode: "full-access",
        }),
      ).toMatchObject({ ok: false, error: "permission_exceeds_parent" });
      expect(spawn("wide", middle, "full-access")).toMatchObject({
        ok: false,
        error: "permission_exceeds_parent",
      });
      await send(descendant);
      expect(h.contexts.at(-1)?.permissionMode).toBe("read-only");
      expect(store.getThread(descendant)?.permission?.effective).toBe("read-only");
      const run = Object.values(store.snapshotThread(middle).runs)[0];
      if (!run) throw new Error("Missing completed middle turn");
      const fork = command({
        type: "thread.fork",
        threadId: middle,
        point: { type: "turn", runId: run.id },
        input: "fork",
        budgetBytes: 4096,
      });
      expect(fork.ok).toBe(true);
      await engine.flush();
      expect(h.contexts.at(-1)?.permissionMode).toBe("read-only");
      if (!fork.forkThreadId) throw new Error("Missing fork");
      expect(store.getThread(fork.forkThreadId)?.permission?.effective).toBe("read-only");
      const inherited = spawn("inherited", middle).threadId;
      if (!inherited) throw new Error("Missing inherited");
      await send(inherited);
      expect(h.contexts.at(-1)?.permissionMode).toBe("read-only");
    } finally {
      await engine.close();
      await store.close();
      await h.close();
    }
  },
);

test("scripted transition threads launch and fork under the default auto-review contract", async () => {
  const h = transitionHarness({ native: true });
  try {
    const source = await h.create();
    expect(h.store.getThread(source)?.status.state).toBe("done");
    expect(h.sessions[0]?.context.permissionMode).toBe("auto-review");
    const child = await h.fork(source);
    expect(h.store.getThread(child)?.status.state).toBe("done");
    expect(h.sessions.at(-1)?.context.permissionMode).toBe("auto-review");
  } finally {
    await h.close();
  }
});
