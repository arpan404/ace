import { expect, test } from "vitest";
import { createAcpAdapter, openAcpSession, genericQuirks } from "@ace/adapter-acp";
import { fileURLToPath } from "node:url";
import type { Frame } from "@ace/engine-api";
import { harness, scriptFrames } from "./test-support.ts";

test.each(["auto-review", "ask", "full-access"] as const)(
  "public mode changes keep ACP's %s permission contract",
  async (mode) => {
    const native = createAcpAdapter(genericQuirks);
    const frames: Frame[] = [];
    const h = await harness([], scriptFrames(), {
      provider: "acp",
      permissionSettings: async () => mode,
      capabilities: native.capabilities({
        installed: true,
        auth: "logged_in",
        loginHint: "unused",
        version: "1.0.0",
      }),
      nativeAdapter: {
        ...native,
        openSession(ctx) {
          const context = { ...ctx };
          delete context.model;
          return openAcpSession(
            {
              ...context,
              onFrame(frame) {
                frames.push(frame);
                ctx.onFrame(frame);
              },
            },
            genericQuirks,
            {
              command: process.execPath,
              args: [
                fileURLToPath(
                  new URL(
                    "../../../../packages/adapter-acp/src/testing/permission-server.ts",
                    import.meta.url,
                  ),
                ),
                "--no-permission",
              ],
            },
          );
        },
      },
    });
    try {
      const id = await h.create();
      h.command({ type: "thread.mode.set", threadId: id, mode: "bypassPermissions" });
      await h.engine.flush();
      const selected = frames
        .filter(
          (frame) =>
            frame.dir === "send" &&
            JSON.stringify(frame.data).includes('"session/set_config_option"'),
        )
        .map((frame) => frame.data);
      expect(JSON.stringify(selected).includes('"bypassPermissions"')).toBe(mode === "full-access");
      expect(h.engine.permissionMode(id)).toBe(mode);
      if (mode !== "full-access") {
        expect(h.store.getThread(id)?.status.state).toBe("done");
        expect(
          Object.values(h.store.snapshotThread(id).items).some(
            (item) => item.type === "notice" && item.text.includes("restricted"),
          ),
        ).toBe(true);
      }
    } finally {
      await h.close();
    }
  },
);
