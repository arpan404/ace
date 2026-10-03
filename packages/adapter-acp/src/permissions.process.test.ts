import { expect, test } from "vitest";
import { ThreadId } from "@ace/protocol";
import { openAcpSession } from "./index.ts";
import { genericQuirks } from "./quirks/generic.ts";

test.each(["auto-review", "ask", "read-only"] as const)(
  "unverified ACP %s cannot start a provider process",
  async (permissionMode) => {
    await expect(
      openAcpSession(
        {
          threadId: ThreadId.parse("permission"),
          cwd: "/synthetic",
          permissionMode,
          signal: new AbortController().signal,
          onFrame() {},
          onExit() {},
        },
        genericQuirks,
        { command: "must-not-start", args: [] },
        {
          now: () => 0,
          spawn: () => {
            throw new Error("process was incorrectly started");
          },
        },
      ),
    ).rejects.toThrow("no verified comprehensive approval gate");
  },
);
