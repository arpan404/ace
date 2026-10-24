import { expect, test } from "vitest";
import { InputRejected, type Frame } from "@ace/engine-api";
import { sessionHarness } from "./testing/harness.ts";
import { obj } from "./native.ts";

const prompts = (frames: Frame[]) =>
  frames.filter((frame) => frame.dir === "send" && obj(frame.data).type === "prompt");
const command = (name: string) => ({
  type: "mention" as const,
  entryId: name,
  kind: "command" as const,
  name,
  arguments: "",
  invocation: { type: "slash" as const, name },
});

test("a prompt Pi turns down before acceptance is reported as never taken", async () => {
  const h = await sessionHarness();
  try {
    const refused = h.session.send([{ type: "text", text: "refuse" }], "steer");
    await expect(refused).rejects.toThrow("No model");
    await expect(refused).rejects.toBeInstanceOf(InputRejected);
    // The session stays usable: the next prompt is accepted and runs.
    await h.session.send([{ type: "text", text: "hello" }], "queue");
    expect(prompts(h.frames)).toHaveLength(2);
  } finally {
    await h.dispose();
  }
});

test("a Pi send whose first prompt was accepted may have run when a later one is refused", async () => {
  const h = await sessionHarness();
  try {
    const partial = h.session.send([command("first"), command("refuse")], "queue");
    await expect(partial).rejects.toThrow("No model");
    await expect(partial).rejects.not.toBeInstanceOf(InputRejected);
    expect(prompts(h.frames)).toHaveLength(2);
  } finally {
    await h.dispose();
  }
});

test("a Pi send after the session closed never reaches Pi", async () => {
  const h = await sessionHarness();
  try {
    await h.session.close("user");
    const late = h.session.send([{ type: "text", text: "late" }], "queue");
    await expect(late).rejects.toBeInstanceOf(InputRejected);
    expect(prompts(h.frames)).toHaveLength(0);
  } finally {
    await h.dispose();
  }
});
