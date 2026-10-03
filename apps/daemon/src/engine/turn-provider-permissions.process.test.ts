import { expect, test } from "vitest";
import { createTurnProvider, ScriptedTurnConfig } from "@ace/adapter-testkit";
import { harness, scriptFrames } from "./test-support.ts";

test.each([undefined, "read-only", "ask", "auto-review", "full-access"] as const)(
  "scripted turn providers finish under the engine's %s permission setting",
  async (mode) => {
    const adapter = createTurnProvider({
      provider: "codex",
      reply: "scripted permission reply",
      config: ScriptedTurnConfig.parse({}),
      now: () => 1000,
      schedule() {
        throw new Error("This immediate fixture must not schedule a timer");
      },
    });
    const h = await harness([], scriptFrames(), {
      nativeAdapter: adapter,
      ...(mode ? { permissionSettings: async () => mode } : {}),
    });
    try {
      const id = await h.create();
      expect(h.contexts[0]?.permissionMode).toBe(mode ?? "auto-review");
      expect(h.store.getThread(id)?.permission?.effective).toBe(mode ?? "auto-review");
      expect(h.store.getThread(id)?.status.state).toBe("done");
      expect(
        Object.values(h.store.snapshotThread(id).items).some(
          (item) =>
            item.type === "message" &&
            item.role === "assistant" &&
            item.parts.some(
              (part) => part.type === "text" && part.text === "scripted permission reply",
            ),
        ),
      ).toBe(true);
      expect(h.errors).toEqual([]);
    } finally {
      await h.close();
    }
  },
);
