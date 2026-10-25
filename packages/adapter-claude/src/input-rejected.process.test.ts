import { expect, test } from "vitest";
import { InputRejected, type Frame } from "@ace/engine-api";
import { harness } from "./session.test-helper.ts";
import { object } from "./native.ts";

const userMessages = (frames: Frame[]) =>
  frames.filter((frame) => frame.dir === "send" && object(frame.data)["type"] === "user");

test("a message sent after the Claude CLI exited is reported as never taken", async () => {
  const h = await harness();
  try {
    await h.session.send([{ type: "text", text: "crash" }], "queue");
    expect(await h.exit).toMatchObject({ deliberate: false });
    const after = h.session.send([{ type: "text", text: "after the crash" }], "steer");
    await expect(after).rejects.toBeInstanceOf(InputRejected);
    expect(userMessages(h.frames)).toHaveLength(1);
  } finally {
    await h.session.close("shutdown");
  }
});

test("input the Claude SDK cannot carry is refused before any of it reaches the CLI", async () => {
  const h = await harness();
  try {
    const sent = h.session.send(
      [
        { type: "text", text: "first" },
        {
          type: "mention",
          entryId: "unresolved",
          kind: "command",
          name: "Unresolved",
          arguments: "",
        },
      ],
      "queue",
    );
    await expect(sent).rejects.toBeInstanceOf(InputRejected);
    expect(userMessages(h.frames)).toHaveLength(0);
  } finally {
    await h.session.close("user");
  }
});
