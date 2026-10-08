import { expect, test } from "vitest";
import { fileURLToPath } from "node:url";
import { ThreadId, type Capabilities } from "@ace/protocol";
import type { Frame } from "@ace/engine-api";
import { openAcpSession, genericQuirks } from "./index.ts";
import { object } from "./data.ts";
test.each([false, true])(
  "ACP relays advertised selectors without a permission ceiling, legacy=%s",
  async (legacy) => {
    const frames: Frame[] = [];
    let capabilities: Capabilities | undefined;
    const session = await openAcpSession(
      {
        threadId: ThreadId.parse("selectors"),
        cwd: process.cwd(),
        permissionMode: "build",
        signal: new AbortController().signal,
        onFrame(frame) {
          frames.push(frame);
        },
        onExit() {},
        onCapabilities(value) {
          capabilities = value;
        },
      },
      genericQuirks,
      {
        command: process.execPath,
        args: [
          fileURLToPath(new URL("./testing/permission-server.ts", import.meta.url)),
          "--no-permission",
          ...(legacy ? ["--legacy"] : []),
        ],
      },
    );
    try {
      expect(
        capabilities?.permissionModes?.map((mode) => ({ id: mode.id, label: mode.label })),
      ).toEqual([
        { id: "read-only", label: "Read only" },
        { id: "build", label: "Build" },
        { id: "bypassPermissions", label: "Bypass" },
      ]);
      await session.setMode?.("bypassPermissions");
      const selections = frames
        .filter(
          (frame) =>
            frame.dir === "send" &&
            ["session/set_mode", "session/set_config_option"].includes(
              String(object(frame.data).method),
            ),
        )
        .map((frame) => object(object(frame.data).params)[legacy ? "modeId" : "value"]);
      expect(selections).toEqual(["build", "bypassPermissions"]);
    } finally {
      await session.close("shutdown");
    }
  },
);
