import { longHistory } from "@ace/fake-daemon";
import { act, cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";
import { harness, memoryKeyValue } from "@/test/harness.tsx";
import { memoryStorage } from "@/boot/client.ts";
import { resetDismissed } from "./composer/dismissed-sends.ts";
import { resetSendStore } from "./composer/send-store.ts";
import { reloadPage, resetStaged, stage, stagedSends } from "./composer/staged-sends.ts";
import { Command, ThreadId } from "@ace/protocol";

beforeEach(() => {
  resetDismissed();
  resetSendStore();
  resetStaged();
});

test.each(["initial", "retry"])(
  "a failed %s outbox save survives reload with one recoverable message",
  async (attempt) => {
    const storage = memoryKeyValue();
    const outbox = memoryStorage();
    let fail = false;
    const first = harness({
      storage,
      outbox: {
        load: outbox.load,
        save: async (value) => {
          if (fail) throw new Error("storage full");
          await outbox.save(value);
        },
      },
    });
    first.play(longHistory(2)).runUntilBlocked();
    await first.open("/t/thread-router");
    const field = await screen.findByRole("combobox", { name: "Message" });
    fail = true;
    await userEvent.type(field, "Keep this across reload{Enter}");
    await screen.findByRole("button", { name: "Retry" });
    if (attempt === "retry") {
      await userEvent.click(screen.getByRole("button", { name: "Retry" }));
      await screen.findByText("It still didn't go");
    }
    cleanup();
    await first.client.close();
    reloadPage();
    const again = harness({ storage, outbox });
    again.play(longHistory(2)).runUntilBlocked();
    await again.open("/t/thread-router");
    await screen.findByRole("combobox", { name: "Message" });
    const feed = await screen.findByRole("feed", { name: "Transcript" });
    expect(within(feed).getAllByText("Keep this across reload")).toHaveLength(1);
    expect(screen.getByRole("combobox", { name: "Message" }).textContent).toBe("");
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Retry" })).toBeNull());
    const view = again.daemon.snapshot({
      kind: "thread",
      threadId: ThreadId.parse("thread-router"),
    });
    expect(
      view?.kind === "thread" &&
        Object.values(view.items).filter(
          (item) =>
            item.type === "message" &&
            item.parts.some(
              (part) => part.type === "text" && part.text === "Keep this across reload",
            ),
        ),
    ).toHaveLength(1);
  },
);

test("Edit restores an uploaded attachment after a failed save and reload", async () => {
  const storage = memoryKeyValue();
  const outbox = memoryStorage();
  let fail = false;
  const first = harness({
    storage,
    outbox: {
      load: outbox.load,
      save: async (value) => {
        if (fail) throw new Error("storage full");
        await outbox.save(value);
      },
    },
  });
  first.play(longHistory(2)).runUntilBlocked();
  await first.open("/t/thread-router");
  await screen.findByRole("combobox", { name: "Message" });
  await userEvent.upload(
    screen.getByLabelText("Files to attach"),
    new File(["saved file"], "notes.txt", { type: "text/plain" }),
  );
  await screen.findByRole("button", { name: "Remove notes.txt" });
  await waitFor(() =>
    expect(screen.queryByRole("progressbar", { name: "Uploading notes.txt" })).toBeNull(),
  );
  fail = true;
  await userEvent.type(screen.getByRole("combobox", { name: "Message" }), "Keep the file{Enter}");
  await screen.findByRole("button", { name: "Retry" });
  cleanup();
  await first.client.close();
  reloadPage();
  const again = harness({ storage, outbox });
  again.play(longHistory(2)).runUntilBlocked();
  await again.open("/t/thread-router");
  await screen.findByRole("combobox", { name: "Message" });
  await userEvent.click(await screen.findByRole("button", { name: "Edit" }));
  await waitFor(() =>
    expect(screen.getByRole("combobox", { name: "Message" }).textContent).toBe("Keep the file"),
  );
  expect(await screen.findByRole("button", { name: "Remove notes.txt" })).toBeTruthy();
  expect(
    within(screen.getByRole("feed", { name: "Transcript" })).queryByText("Keep the file"),
  ).toBeNull();
});

test("closing the page while its initial outbox save is pending preserves the message", async () => {
  const saving = Promise.withResolvers<void>();
  const storage = memoryKeyValue();
  const outbox = memoryStorage();
  let hold = false;
  const first = harness({
    storage,
    outbox: {
      load: outbox.load,
      save: async (value) => {
        if (hold) {
          await saving.promise;
          throw new Error("storage full");
        }
        await outbox.save(value);
      },
    },
  });
  first.play(longHistory(2)).runUntilBlocked();
  await first.open("/t/thread-router");
  hold = true;
  await userEvent.type(
    await screen.findByRole("combobox", { name: "Message" }),
    "Keep the pending save{Enter}",
  );
  await waitFor(() =>
    expect(
      first.client
        .pendingSends("thread-router")
        .getSnapshot()
        .some((send) => send.state === "saving"),
    ).toBe(true),
  );
  // Browser storage as it stood when the page ended, without the old page's later callback.
  const atReload = memoryKeyValue();
  for (const [key, value] of storage.data) atReload.setItem(key, value);
  await act(async () => saving.resolve());
  await screen.findByRole("button", { name: "Retry" });
  cleanup();
  await first.client.close();
  reloadPage();
  Object.defineProperty(navigator, "locks", {
    configurable: true,
    value: { query: async () => ({ held: [] }) },
  });
  try {
    const again = harness({ storage: atReload, outbox });
    again.play(longHistory(2)).runUntilBlocked();
    await again.open("/t/thread-router");
    const feed = await screen.findByRole("feed", { name: "Transcript" });
    await within(feed).findByText("Keep the pending save");
    await userEvent.click(await within(feed).findByRole("button", { name: "Retry" }));
    await waitFor(() => expect(within(feed).queryByRole("button", { name: "Retry" })).toBeNull());
    expect(within(feed).getAllByText("Keep the pending save")).toHaveLength(1);
  } finally {
    saving.resolve();
    Reflect.deleteProperty(navigator, "locks");
  }
});

test.each(["saving", "admitted"])(
  "a leftover upload record does not offer Retry while its message is %s",
  async (state) => {
    const saving = Promise.withResolvers<void>();
    const outbox = memoryStorage();
    let hold = false;
    const made = harness({
      outbox: {
        load: outbox.load,
        save: async (value) => {
          if (hold) await saving.promise;
          await outbox.save(value);
        },
      },
    });
    made.play(longHistory(2)).runUntilBlocked();
    await made.client.start();
    stagedSends(made.storage);
    stage(
      {
        commandId: "leftover",
        threadId: "thread-router",
        text: "Already on its way",
        mentions: [],
        attachments: [],
      },
      { files: [], previews: [] },
    );
    hold = true;
    const enqueued = made.client.enqueue(
      {
        type: "thread.send",
        threadId: ThreadId.parse("thread-router"),
        input: [{ type: "text", text: "Already on its way" }],
      },
      "leftover",
    );
    if (state === "admitted") {
      saving.resolve();
      await enqueued;
      await made.client.command({
        type: "thread.rename",
        threadId: ThreadId.parse("thread-router"),
        title: "Admission barrier",
      });
    }
    // The tab ended before its enqueue callback could remove the held record.
    reloadPage();
    Object.defineProperty(navigator, "locks", {
      configurable: true,
      value: { query: async () => ({ held: [] }) },
    });
    try {
      await made.open("/t/thread-router");
      const feed = await screen.findByRole("feed", { name: "Transcript" });
      await within(feed).findByText("Already on its way");
      await act(async () => {});
      expect(within(feed).queryByRole("button", { name: "Retry" })).toBeNull();
      expect(within(feed).queryByText("Not sent")).toBeNull();
      saving.resolve();
      await enqueued;
      await waitFor(() => expect(within(feed).queryByText("Sending…")).toBeNull());
      expect(within(feed).getAllByText("Already on its way")).toHaveLength(1);
    } finally {
      saving.resolve();
      Reflect.deleteProperty(navigator, "locks");
    }
  },
);

test("a leftover held copy offers no Retry when the transcript owns it and the outbox is empty", async () => {
  const made = harness();
  made.play(longHistory(2)).runUntilBlocked();
  stagedSends(made.storage);
  stage(
    {
      commandId: "admitted",
      threadId: "thread-router",
      text: "Already delivered",
      mentions: [],
      attachments: [],
    },
    { files: [], previews: [] },
  );
  expect(
    made.daemon.command(
      Command.parse({
        id: "admitted",
        deviceId: "test-device",
        payload: {
          type: "thread.send",
          threadId: "thread-router",
          input: [{ type: "text", text: "Already delivered" }],
        },
      }),
    ),
  ).toMatchObject({ ok: true });
  reloadPage();
  Object.defineProperty(navigator, "locks", {
    configurable: true,
    value: { query: async () => ({ held: [] }) },
  });
  try {
    await made.open("/t/thread-router");
    const feed = await screen.findByRole("feed", { name: "Transcript" });
    await within(feed).findByText("Already delivered");
    await act(async () => {});
    expect(made.client.pendingSends("thread-router").getSnapshot()).toEqual([]);
    expect(within(feed).queryByRole("button", { name: "Retry" })).toBeNull();
    expect(within(feed).getAllByText("Already delivered")).toHaveLength(1);
  } finally {
    Reflect.deleteProperty(navigator, "locks");
  }
});
