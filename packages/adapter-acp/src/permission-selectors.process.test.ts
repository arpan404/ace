import { expect, test } from "vitest";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { ThreadId } from "@ace/protocol";
import type { Frame } from "@ace/engine-api";
import { openAcpSession, genericQuirks } from "./index.ts";

const Envelope = z.object({ method: z.string(), params: z.record(z.string(), z.unknown()) });

test.each(
  [false, true].flatMap((legacy) =>
    (["read-only", "ask", "auto-review", "full-access"] as const).map((mode) => ({ legacy, mode })),
  ),
)(
  "ACP $mode keeps its permission ceiling through public selectors, legacy: $legacy",
  async ({ legacy, mode }) => {
    const frames: Frame[] = [];
    const session = await openAcpSession(
      {
        threadId: ThreadId.parse("selectors"),
        cwd: process.cwd(),
        permissionMode: mode,
        signal: new AbortController().signal,
        onFrame: (frame) => {
          frames.push(frame);
        },
        onExit() {},
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
      if (!session.setMode) throw new Error("Missing advertised selector");
      await session.setMode("read-only");
      if (mode === "full-access") {
        await session.setMode("build");
        await session.setMode("bypassPermissions");
      } else {
        await expect(session.setMode("build")).rejects.toThrow("restricted");
        await expect(session.setMode("bypassPermissions")).rejects.toThrow("restricted");
      }
      await expect(session.setMode("unknown")).rejects.toThrow("unavailable");
      await session.send([{ type: "text", text: "scripted selector check" }], "queue");
      const selections = frames
        .filter((frame) => frame.dir === "send")
        .flatMap((frame) => {
          const parsed = Envelope.safeParse(frame.data);
          if (
            !parsed.success ||
            parsed.data.method !== (legacy ? "session/set_mode" : "session/set_config_option")
          )
            return [];
          return [parsed.data.params[legacy ? "modeId" : "value"]];
        });
      expect(selections).toEqual(
        mode === "full-access"
          ? ["read-only", "build", "bypassPermissions"]
          : ["read-only", "read-only"],
      );
    } finally {
      await session.close("shutdown");
    }
  },
);
