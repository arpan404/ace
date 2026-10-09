import { ThreadId } from "@ace/protocol";
import { memoryStorage } from "@/boot/client.ts";
import { seedRealThreadState } from "@ace/fake-daemon";
import { act, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { harness } from "@/test/harness.tsx";
afterEach(() => vi.unstubAllGlobals());

test("Needs you lists model selection, restart holds and failed sends and removes released holds", async () => {
  const app = harness();
  seedRealThreadState(app.daemon);
  await app.open("/activity");
  const main = await screen.findByRole("main");
  expect(
    await within(main).findAllByRole("link", { name: "Fix the model selection: Pick a model" }),
  ).not.toHaveLength(0);
  expect(
    within(main).getAllByRole("link", {
      name: "Finish the background build: Stopped by a restart",
    }),
  ).not.toHaveLength(0);
  expect(
    within(main).getAllByRole("link", { name: "Check the saved message: Message not sent" }),
  ).not.toHaveLength(0);
  expect(within(main).queryByText("You're all caught up")).toBeNull();
  act(() => app.daemon.updateThread("legacy-send", { status: { state: "done" } }));
  // A completed old turn cannot hide its held message.
  expect(
    within(main).getAllByRole("link", { name: "Check the saved message: Message not sent" }),
  ).not.toHaveLength(0);
  const queue = await app.client.request({
    type: "queue.get",
    threadId: (await import("@ace/protocol")).ThreadId.parse("legacy-send"),
  });
  await act(() =>
    app.client.command({
      type: "queue.resume",
      threadId: queue.queue.threadId,
      expectedRevision: queue.queue.revision,
    }),
  );
  await waitFor(() =>
    expect(
      within(main).queryAllByRole("link", { name: "Check the saved message: Message not sent" }),
    ).toHaveLength(0),
  );
});

test("a narrow Activity inbox shows held sends and opens their original thread", async () => {
  vi.stubGlobal("matchMedia", (query: string): MediaQueryList => ({
    media: query,
    matches: query.includes("max-width"),
    onchange: null,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent: () => true,
  }));
  const app = harness();
  seedRealThreadState(app.daemon);
  await app.open("/activity");
  const user = (await import("@testing-library/user-event")).default;
  await user.click(await screen.findByRole("tab", { name: /^Needs you/ }));
  await user.click(
    await screen.findByRole("link", { name: "Check the saved message: Message not sent" }),
  );
  expect(await screen.findByRole("feed", { name: "Transcript" })).toBeTruthy();
  expect(await screen.findByRole("list", { name: "Queued messages" })).toBeTruthy();
});

test("Needs you includes a locally failed send and an unavailable selection without queue holds", async () => {
  const stored = memoryStorage();
  let fail = false;
  const app = harness({
    outbox: {
      load: () => stored.load(),
      save: (value) => (fail ? Promise.reject(new Error("disk full")) : stored.save(value)),
    },
  });
  app.daemon.createThread({
    id: "local-send",
    workspaceId: "relay",
    title: "Save my next message",
    provider: "opencode",
  });
  app.daemon.createThread({
    id: "missing-model",
    workspaceId: "relay",
    title: "Choose an available model",
    provider: "opencode",
  });
  app.daemon.updateThread("missing-model", {
    execution: { provider: "opencode", model: "removed/model", options: {} },
  });
  await app.open("/activity");
  await screen.findAllByRole("link", { name: "Choose an available model: Pick a model" });
  app.client.networkOnline(false);
  fail = true;
  await act(async () => {
    await expect(
      app.client.enqueue(
        {
          type: "thread.send",
          threadId: ThreadId.parse("local-send"),
          input: [{ type: "text", text: "Keep this message" }],
        },
        "local-send-original",
      ),
    ).rejects.toMatchObject({ code: "storage" });
  });
  const main = await screen.findByRole("main");
  expect(
    await within(main).findAllByRole("link", { name: "Save my next message: Message not sent" }),
  ).not.toHaveLength(0);
  expect(
    await within(main).findAllByRole("link", { name: "Choose an available model: Pick a model" }),
  ).not.toHaveLength(0);
});
