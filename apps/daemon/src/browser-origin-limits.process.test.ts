import { expect, it } from "vitest";
import { originFixture } from "./browser-origin-test-support.ts";

it("thread grants refuse overflow without silently losing consent; revocation frees capacity", async () => {
  const f = await originFixture();
  for (let count = 0; count < 256; count++)
    f.browser.originsGrant(f.thread.id, `https://site-${count}.example`);
  f.browser.originsGrant(f.thread.id, "https://site-0.example");
  expect(() => f.browser.originsGrant(f.thread.id, "https://overflow.example")).toThrow(
    "grant limit",
  );
  expect(f.browser.originsList(f.thread.id)).toHaveLength(256);
  await f.navigation("https://site-0.example/page");
  f.browser.originsRevoke(f.thread.id, "https://site-0.example");
  f.browser.originsGrant(f.thread.id, "https://overflow.example");
  expect(await f.navigation("https://overflow.example")).toMatchObject({
    url: "https://overflow.example",
  });
  expect(await f.headless.opens[0]?.allowed("wss://site-0.example/live")).toBe(false);
});
it("another connection cannot turn navigation into consent while the owner's human lease is active", async () => {
  const f = await originFixture();
  const owner = await f.client();
  const other = await f.client("a".repeat(64), "other");
  await owner.request({ type: "browser.takeover", requestId: "take", threadId: f.thread.id });
  expect(
    await other.request({
      type: "browser.execute",
      requestId: "visit",
      threadId: f.thread.id,
      command: { action: "navigate", url: "https://youtube.com" },
    }),
  ).toMatchObject({ ok: false, error: "Browser controller mismatch" });
  expect(f.browser.originsList(f.thread.id)).toEqual([]);
  expect(f.browser.state(f.thread.id).url).toBe("about:blank");
});
it("an aborted explicit navigation expires its approval and cannot grant the origin through a late answer", async () => {
  const f = await originFixture();
  const signal = new AbortController();
  const opened = f.opened();
  const failure = expect(
    f.browser.execute(
      f.thread.id,
      { action: "navigate", url: "https://youtube.com" },
      { kind: "agent" },
      signal.signal,
    ),
  ).rejects.toThrow();
  const interaction = await opened;
  signal.abort();
  await failure;
  expect(f.store.getInteraction(interaction.id)?.state).toBe("expired");
  expect(f.resolve(interaction, "allow_thread").ok).toBe(false);
  expect(f.browser.originsList(f.thread.id)).toEqual([]);
});
it("a browser approval cannot be answered by a connection excluded from that thread", async () => {
  const f = await originFixture();
  const excluded = await f.client("a".repeat(64), "excluded");
  const opened = f.opened();
  const navigation = f.navigation();
  const interaction = await opened;
  excluded.send({
    type: "command",
    command: {
      id: "bad-answer",
      deviceId: "excluded",
      payload: {
        type: "interaction.resolve",
        interactionId: interaction.id,
        resolution: { kind: "approval", optionId: "allow_thread" },
      },
    },
  });
  expect(
    await excluded.next(
      (message) => message.type === "commandResult" && message.commandId === "bad-answer",
    ),
  ).toMatchObject({ ok: false, error: "browser_thread_access_denied" });
  expect(f.store.getInteraction(interaction.id)?.state).toBe("pending");
  expect(f.resolve(interaction, "allow_thread").ok).toBe(true);
  await navigation;
});
