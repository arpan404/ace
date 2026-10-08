import { expect, test } from "vitest";
import { fileURLToPath } from "node:url";
import { ThreadId } from "@ace/protocol";
import type { Frame } from "@ace/engine-api";
import { openAcpSession, createAcpTranslator, genericQuirks } from "./index.ts";
import type { Fact } from "@ace/core";
test("ACP approval requests remain human work and the answer returns to the harness", async () => {
  const threadId = ThreadId.parse("approval");
  const frames: Frame[] = [];
  const translator = createAcpTranslator({
    threadId,
    rootKey: "root",
    identity: { generation: "test", cursor: 0 },
  });
  const opened = Promise.withResolvers<Extract<Fact, { type: "interaction.opened" }>>();
  const replied = Promise.withResolvers<void>();
  const session = await openAcpSession(
    {
      threadId,
      cwd: process.cwd(),
      signal: new AbortController().signal,
      onFrame(frame) {
        frames.push(frame);
        for (const fact of translator.translate(frame, frame.t))
          if (fact.type === "interaction.opened") opened.resolve(fact);
        if (frame.dir === "recv" && JSON.stringify(frame.data).includes("selected"))
          replied.resolve();
      },
      onExit() {},
    },
    genericQuirks,
    {
      command: process.execPath,
      args: [fileURLToPath(new URL("./testing/permission-server.ts", import.meta.url))],
    },
  );
  try {
    const sending = session.send([{ type: "text", text: "scripted approval" }], "queue");
    const approval = await opened.promise;
    expect(approval.request.kind).toBe("approval");
    await session.resolve(approval.interaction, { kind: "approval", optionId: "once" });
    await sending;
    await replied.promise;
    expect(
      frames.some(
        (frame) => frame.dir === "send" && JSON.stringify(frame.data).includes('"optionId":"once"'),
      ),
    ).toBe(true);
  } finally {
    await session.close("shutdown");
  }
});
