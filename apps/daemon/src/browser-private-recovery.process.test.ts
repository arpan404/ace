import { expect, it } from "vitest";
import { originFixture } from "./browser-origin-test-support.ts";

it("reconstructing daemon services without a handback restores connected private ownership", async () => {
  const original = await originFixture();
  const threadId = original.thread.id;
  await original.browser.closeThread(threadId);
  await original.browser.open({
    threadId,
    workspaceId: original.thread.workspaceId,
    profile: "persistent",
  });
  original.browser.takeover(threadId, "still-connected", "private");
  const pending = Object.values(original.store.snapshotThread(threadId).interactions).filter(
    (interaction) =>
      interaction.state === "pending" &&
      interaction.raw.some((raw) => raw.type === "ace.browser.private"),
  );
  expect(pending).toHaveLength(1);
  expect(original.browser.state(threadId)).toMatchObject({
    owner: "still-connected",
    takeoverMode: "private",
    status: "ready",
  });
  // Reconstruct from the same SQLite file before any disconnect/close/handback cleanup.
  // This is the durable boundary an unclean process stop leaves behind; no gate is manufactured.
  const recovered = await originFixture("ask", original.home);
  expect(recovered.browser.state(threadId)).toMatchObject({
    controller: "none",
    takeoverMode: "private",
    status: "paused",
  });
  for (const command of [{ action: "snapshot" }, { action: "logs" }])
    await expect(recovered.browser.execute(threadId, command)).rejects.toMatchObject({
      code: "human_private",
    });
  expect(() => recovered.browser.takeover(threadId, "new-owner", "shared")).toThrow(/handback/);
  recovered.browser.takeover(threadId, "new-owner", "private");
  recovered.browser.handback(threadId, "new-owner");
  expect(recovered.browser.state(threadId)).toMatchObject({
    controller: "agent",
    takeoverMode: "shared",
    status: "ready",
  });
  expect(
    Object.values(recovered.store.snapshotThread(threadId).interactions).some(
      (interaction) =>
        interaction.state === "pending" &&
        interaction.raw.some((raw) => raw.type === "ace.browser.private"),
    ),
  ).toBe(false);
});
