import { expect, test } from "vitest";
import { fileURLToPath } from "node:url";
import { ThreadId } from "@ace/protocol";
import type { Frame } from "@ace/engine-api";
import { reviewPermission } from "@ace/core";
import { openAcpSession, createAcpTranslator } from "./index.ts";
import { genericQuirks } from "./quirks/generic.ts";
import { object } from "./data.ts";

test.each(
  [false, true].flatMap((noSelectors) => [false, true].map((resume) => ({ noSelectors, resume }))),
)(
  "ACP auto-review launches with no full-access fallback, absent selectors: $noSelectors, resumed: $resume",
  async ({ noSelectors, resume }) => {
    const frames: Frame[] = [],
      threadId = ThreadId.parse("permission");
    const translator = createAcpTranslator({
      threadId,
      rootKey: "root",
      identity: { generation: "test", cursor: 0 },
    });
    const approval =
      Promise.withResolvers<Extract<import("@ace/core").Fact, { type: "interaction.opened" }>>();
    const session = await openAcpSession(
      {
        threadId,
        cwd: process.cwd(),
        permissionMode: "auto-review",
        ...(resume ? { resume: { nativeSessionId: "native" } } : {}),
        signal: new AbortController().signal,
        onFrame(frame) {
          frames.push(frame);
          for (const fact of translator.translate(frame, frame.t))
            if (fact.type === "interaction.opened") approval.resolve(fact);
        },
        onExit() {},
      },
      genericQuirks,
      {
        command: process.execPath,
        args: [
          fileURLToPath(new URL("./testing/permission-server.ts", import.meta.url)),
          ...(noSelectors ? ["--no-selectors"] : []),
        ],
      },
    );
    try {
      const selections = frames.filter(
        (f) => f.dir === "send" && object(f.data)["method"] === "session/set_config_option",
      );
      expect(selections.map((f) => object(object(f.data)["params"])["value"])).toEqual(
        noSelectors ? [] : ["read-only"],
      );
      const sending = session.send([{ type: "text", text: "scripted permission" }], "queue");
      const fact = await approval.promise;
      if (fact.request.kind !== "approval" || !fact.request.target)
        throw new Error("Missing native approval");
      const decision = reviewPermission({
        mode: "auto-review",
        target: fact.request.target,
        paths: [],
      });
      expect(decision).toEqual({
        decision: "approve",
        reason: "Read-only workspace inspection command",
      });
      await session.resolve(fact.interaction, {
        kind: "approval",
        optionId: "once",
        message: decision.reason,
      });
      await sending;
      expect(
        frames.some((f) => f.dir === "recv" && JSON.stringify(f.data).includes("selected")),
      ).toBe(true);
    } finally {
      await session.close("shutdown");
    }
  },
);
