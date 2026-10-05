import { expect, it, onTestFinished } from "vitest";
import { InteractionId } from "@ace/protocol";
import { BrowserApprovals } from "./browser-approvals.ts";
import { originFixture } from "./browser-origin-test-support.ts";

it("canceling evaluate expires its host interaction and releases the browser queue", async () => {
  const f = await originFixture();
  f.browser.originsGrant(f.thread.id, "https://site.example");
  await f.navigation("https://site.example/page");
  const opened = f.opened(),
    abort = new AbortController();
  const rejected = expect(
    f.browser.execute(
      f.thread.id,
      {
        action: "evaluate",
        expression: "document.title",
      },
      { kind: "agent" },
      abort.signal,
    ),
  ).rejects.toThrow("cancel evaluation");
  const interaction = await opened;
  abort.abort(new Error("cancel evaluation"));
  await rejected;
  expect(f.store.getInteraction(interaction.id)?.state).toBe("expired");
  expect(f.resolve(interaction, "allow_once").ok).toBe(false);
  expect(await f.browser.execute(f.thread.id, { action: "snapshot" })).toMatchObject({
    nodes: expect.any(Array),
  });
});

it.each(["shutdown", "abort"] as const)(
  "%s during authority lookup cannot open a late approval",
  async (operation) => {
    const f = await originFixture();
    f.context.services.browserApprovals?.close();
    const entered = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>();
    onTestFinished(() => release.resolve());
    let sequence = 0;
    const alarms = new Set<() => void>();
    const approvals = new BrowserApprovals(
      {
        store: f.store,
        now: () => 1000,
        id: () => `race-${++sequence}`,
        mode: async () => {
          entered.resolve();
          await release.promise;
          return "ask";
        },
        root: (threadId) => f.store.getThread(threadId)?.rootAgentId,
        open: (interaction) => {
          f.store.appendEvents(
            interaction.threadId,
            [{ type: "interaction.opened", interaction }],
            1000,
          );
          return interaction;
        },
        close: (threadId, _key, result, rawId) => {
          f.store.appendEvents(
            threadId,
            [
              {
                type: "interaction.closed",
                interactionId: InteractionId.parse(rawId),
                closedAt: 1000,
                ...result,
              },
            ],
            1000,
          );
        },
      },
      {
        set: (_delay, work) => {
          alarms.add(work);
          return () => {
            alarms.delete(work);
          };
        },
      },
    );
    onTestFinished(() => approvals.close());
    const abort = new AbortController();
    const request = approvals.downloads(f.thread.id, "https://site.example/file", abort.signal);
    const result =
      operation === "abort"
        ? expect(request).rejects.toThrow("cancel lookup")
        : expect(request).resolves.toBe(false);
    await entered.promise;
    if (operation === "shutdown") approvals.close();
    else abort.abort(new Error("cancel lookup"));
    release.resolve();
    await result;
    expect(Object.values(f.store.snapshotThread(f.thread.id).interactions)).toEqual([]);
    // Advancing the injected timer cannot create or retain an interaction after closure.
    for (const alarm of alarms) alarm();
    expect(Object.values(f.store.snapshotThread(f.thread.id).interactions)).toEqual([]);
  },
);
it("the injected approval deadline expires the interaction and rejects a late allow", async () => {
  const { FakeHeadless } = await import("@ace/browser/testing");
  let time = 0,
    sequence = 0;
  const deadlines = new Map<number, { at: number; work(): void }>();
  const clock = {
    now: () => time,
    set: (delay: number, work: () => void) => {
      const id = ++sequence;
      deadlines.set(id, { at: time + delay, work });
      return () => {
        deadlines.delete(id);
      };
    },
  };
  const f = await originFixture("ask", undefined, new FakeHeadless(), clock);
  const approvals = f.context.services.browserApprovals;
  if (!approvals) throw new Error("approvals");
  const opened = f.opened(),
    request = approvals.downloads(f.thread.id, "https://site.example/file");
  const interaction = await opened;
  time = 59_999;
  for (const deadline of deadlines.values()) if (deadline.at <= time) deadline.work();
  expect(f.store.getInteraction(interaction.id)?.state).toBe("pending");
  time++;
  for (const deadline of deadlines.values()) if (deadline.at <= time) deadline.work();
  expect(await request).toBe(false);
  expect(f.store.getInteraction(interaction.id)?.state).toBe("expired");
  expect(f.resolve(interaction, "allow_once").ok).toBe(false);
});
