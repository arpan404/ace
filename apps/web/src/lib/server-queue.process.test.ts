import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createScriptedAdapter } from "@ace/adapter-testkit";
import { Engine, Store, AdapterRegistry } from "@ace/daemon";
import { Command, CommandId, Capabilities, type CommandPayload } from "@ace/protocol";
import { expect, test } from "vitest";
import { readServerQueue } from "./server-queue.ts";

test.each([false, true])(
  "retained queue reads follow production byte bounds and discard changed revisions (change=%s)",
  async (change) => {
    const home = mkdtempSync(join(tmpdir(), "ace-queue-reader-"));
    const store = new Store(join(home, "events.sqlite"), undefined, { now: () => 1000 });
    const registry = new AdapterRegistry();
    registry.register(
      createScriptedAdapter({
        provider: "codex",
        capabilities: Capabilities.parse({
          steer: true,
          interruptCascades: false,
          resume: true,
          fork: false,
          subagentTranscripts: true,
          backgroundTaskControl: true,
          backgroundVisibility: "full",
          planMode: false,
          tokenUsage: false,
          imageInput: true,
          rewindFiles: false,
        }),
        createTranslator: () => ({ translate: () => [], tick: () => [] }),
        steps: [],
      }),
      { installed: true, auth: "logged_in", loginHint: "unused" },
    );
    const engine = new Engine(store, {
      registry,
      clock: { now: () => 1000, setTimer: () => () => {} },
    });
    let serial = 0;
    const command = (payload: CommandPayload, key?: string) => {
      const value = Command.parse({
        id: key ?? `command-${++serial}`,
        deviceId: "reader",
        payload,
      });
      const result = store.recordCommand(value.id, value.deviceId, () =>
        engine.handler.handle(value, store),
      );
      if (!result.ok) throw new Error(result.error);
    };
    try {
      const workspace = store.createWorkspace(home, "Queue reader");
      command(
        {
          type: "thread.create",
          workspaceId: workspace,
          provider: "codex",
          model: "model",
          input: [{ type: "text", text: "0" + "x".repeat(200000) }],
        },
        "large-0",
      );
      const thread = store.listThreads()[0];
      if (!thread) throw new Error("Missing thread");
      const id = thread.id;
      command({ type: "queue.pause", threadId: id, expectedRevision: engine.queue(id).revision });
      for (let i = 1; i < 5; i++)
        command(
          {
            type: "thread.send",
            threadId: id,
            input: [{ type: "text", text: String(i) + "x".repeat(200000) }],
            delivery: "queue",
          },
          `large-${i}`,
        );
      await engine.flush();
      const first = engine.queuePage({ threadId: id, limit: 32 });
      expect(first.messages).toHaveLength(2);
      expect(first.next).toBe("large-1");
      let changed = false;
      const read = () =>
        readServerQueue(id, async (request) => {
          if (change && request.after && !changed) {
            changed = true;
            command({
              type: "queue.edit",
              threadId: id,
              messageId: CommandId.parse("large-4"),
              expectedRevision: engine.queue(id).revision,
              input: [{ type: "text", text: "revised tail" }],
            });
          }
          return engine.queuePage(request);
        });
      if (change) await expect(read()).rejects.toThrow("queue_conflict");
      const page = await read();
      expect(page.messages.map((message) => message.id)).toEqual([
        "large-0",
        "large-1",
        "large-2",
        "large-3",
        "large-4",
      ]);
      expect(page.next).toBeNull();
      expect(page.revision).toBe(engine.queue(id).revision);
      expect(page.messages.at(-1)?.input).toEqual([
        { type: "text", text: change ? "revised tail" : "4" + "x".repeat(200000) },
      ]);
      expect(engine.queue(id)).toMatchObject({ paused: true, pendingCount: 5 });
    } finally {
      await engine.close();
      await store.close();
      rmSync(home, { recursive: true, force: true });
    }
  },
);
