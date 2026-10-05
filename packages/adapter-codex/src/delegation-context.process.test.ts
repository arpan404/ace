import { expect, test } from "vitest";
import { sessionHarness } from "./session.test-helper.ts";
import { obj } from "./native.ts";
test("queued ace fallback is correlated before its native user input is sent", async () => {
  const identities: { commandId: string; nativeId: string }[] = [];
  const h = await sessionHarness(
    false,
    "",
    undefined,
    undefined,
    undefined,
    undefined,
    (identity) => identities.push(identity),
  );
  try {
    await h.session.send([{ type: "text", text: "running" }], "queue");
    await h.wait((frame) => obj(frame.data).method === "turn/started");
    await h.session.send([{ type: "text", text: "ace results" }], "queue", "wake", "ace");
    const queued = h.frames.find(
      (frame) => frame.dir === "send" && obj(frame.data).method === "thread/queue/add",
    );
    expect(identities).toEqual([
      { commandId: "wake", nativeId: obj(obj(queued?.data).params).clientUserMessageId },
    ]);
  } finally {
    await h.dispose();
  }
});

test("ace results reach Codex as untrusted additional context without user input", async () => {
  const h = await sessionHarness();
  try {
    await h.session.send([{ type: "text", text: "ace child results" }], "queue", "wake", "ace");
    const request = h.frames.find(
      (frame) => frame.dir === "send" && obj(frame.data).method === "turn/start",
    );
    expect(obj(request?.data).params).toMatchObject({
      input: [],
      turnTrigger: "subagent_result",
      additionalContext: { "ace.delegation": { kind: "untrusted", value: "ace child results" } },
    });
  } finally {
    await h.dispose();
  }
});
