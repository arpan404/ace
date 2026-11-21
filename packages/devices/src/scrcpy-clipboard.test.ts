import { expect, it } from "vitest";
import { clipboardReplyMs, clipboardSettleMs, ScrcpyClipboard } from "./scrcpy-clipboard.ts";
import type { ControlMessage } from "./scrcpy-protocol.ts";

/** A clipboard over a scripted control socket, with a clock the test moves. */
function socket() {
  let now = 0;
  let timers: { at: number; run: () => void }[] = [];
  const sent: ControlMessage[] = [];
  const clipboard = new ScrcpyClipboard({
    send: (message) => sent.push(message),
    after(ms, run) {
      const timer = { at: now + ms, run };
      timers.push(timer);
      return () => {
        timers = timers.filter((each) => each !== timer);
      };
    },
  });
  const advance = async (ms: number) => {
    const end = now + ms;
    for (;;) {
      const due = timers.filter((timer) => timer.at <= end).toSorted((a, b) => a.at - b.at)[0];
      if (!due) break;
      timers = timers.filter((timer) => timer !== due);
      now = due.at;
      due.run();
      await Promise.resolve();
    }
    now = end;
    await Promise.resolve();
  };
  const reply = (text: string) => clipboard.received({ type: "clipboard", text });
  const asked = () => sent.filter((message) => message.type === "getClipboard").length;
  return { clipboard, advance, reply, asked };
}

it("a read takes the device's reply to it", async () => {
  const { clipboard, reply, asked } = socket();
  const read = clipboard.read("agent");
  expect(asked()).toBe(1);
  reply("text");
  await expect(read).resolves.toBe("text");
});

it("a device that doesn't answer reads as empty", async () => {
  const { clipboard, advance } = socket();
  const read = clipboard.read("agent");
  await advance(clipboardReplyMs);
  await expect(read).resolves.toBe("");
});

it("a person's late reply never reaches an agent's read; the agent gets the device's answer to its own", async () => {
  const { clipboard, advance, reply, asked } = socket();
  // The person's read times out before the device answers it.
  const personRead = clipboard.read("person");
  await advance(clipboardReplyMs);
  await expect(personRead).resolves.toBe("");
  // An agent reads next: its request waits until the person's can no longer be answered...
  let agentText: string | undefined;
  const agentRead = clipboard.read("agent").then((text) => (agentText = text));
  expect(asked()).toBe(1);
  // ...so the person's late reply, arriving now, is theirs and is dropped.
  reply("the person's password");
  await Promise.resolve();
  expect(agentText).toBeUndefined();
  expect(asked()).toBe(2);
  reply("the agent's text");
  await agentRead;
  expect(agentText).toBe("the agent's text");
});

it("a person's read the device never answered holds an agent's back only until it settles", async () => {
  const { clipboard, advance, reply, asked } = socket();
  const personRead = clipboard.read("person");
  await advance(clipboardReplyMs);
  await personRead;
  const agentRead = clipboard.read("agent");
  await advance(clipboardSettleMs - clipboardReplyMs - 1);
  expect(asked()).toBe(1);
  await advance(1);
  expect(asked()).toBe(2);
  reply("the agent's text");
  await expect(agentRead).resolves.toBe("the agent's text");
});

it("one reader's own unanswered read doesn't hold back its next one", async () => {
  const { clipboard, advance, reply, asked } = socket();
  const first = clipboard.read("agent");
  await advance(clipboardReplyMs);
  await expect(first).resolves.toBe("");
  const second = clipboard.read("agent");
  expect(asked()).toBe(2);
  reply("now there is text");
  await expect(second).resolves.toBe("now there is text");
});

it("an agent's late reply never reaches the person's read either", async () => {
  const { clipboard, advance, reply } = socket();
  const agentRead = clipboard.read("agent");
  await advance(clipboardReplyMs);
  await agentRead;
  const personRead = clipboard.read("person");
  reply("the agent's late answer");
  reply("the person's answer");
  await expect(personRead).resolves.toBe("the person's answer");
});
