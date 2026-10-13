import { facts, fixtureImage } from "@ace/fake-daemon";
import { ThreadId } from "@ace/protocol";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";
import { memoryStorage } from "@/boot/client.ts";
import { harness } from "@/test/harness.tsx";
import { uploadTimeoutMs } from "./composer/upload-interruption.ts";
import { resetSendStore } from "./composer/send-store.ts";
import { reloadPage, resetStaged, stagedSends } from "./composer/staged-sends.ts";

beforeEach(() => {
  localStorage.clear();
  resetSendStore();
  resetStaged();
});
const threadId = ThreadId.parse("composer-queue-files");
const image = () =>
  new File([Uint8Array.from(atob(fixtureImage.data), (char) => char.charCodeAt(0))], "pasted.png", {
    type: "image/png",
  });
const readQueue = async (app: ReturnType<typeof harness>) =>
  (await app.client.request({ type: "queue.get", threadId })).queue;

function stalledImage() {
  const file = image();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const slice = file.slice.bind(file);
  file.slice = (start, end, type) => {
    const part = slice(start, end, type);
    const read = part.arrayBuffer.bind(part);
    part.arrayBuffer = async () => {
      entered.resolve();
      await release.promise;
      return read();
    };
    return part;
  };
  return { file, entered, release };
}

function interruptedActions() {
  const failure = screen.getByText(/Upload interrupted$/).closest('[role="alert"]');
  if (!(failure instanceof HTMLElement)) throw new Error("Missing interrupted-upload actions");
  expect(
    within(failure)
      .getAllByRole("button")
      .map((button) => button.textContent),
  ).toEqual(["Remove"]);
  return within(failure).getByRole("button", { name: "Remove" });
}

test("reload interrupts an unfinished upload and Remove releases later messages in order", async () => {
  const { app, message } = await openBusy({ uiClock: () => 1000 });
  await userEvent.upload(
    screen.getByLabelText("Files to attach"),
    new File(["notes"], "notes.txt", { type: "text/plain" }),
  );
  await waitFor(() => expect(screen.queryByRole("progressbar")).toBeNull());
  const { file, entered, release } = stalledImage();
  try {
    await userEvent.upload(screen.getByLabelText("Files to attach"), file);
    await entered.promise;
    await userEvent.type(message, "A pending upload{Enter}B behind A{Enter}C behind B{Enter}");
    cleanup();
    await app.client.close();
    reloadPage();
    resetSendStore();
    const again = harness({ daemon: app.daemon, storage: app.storage, uiClock: () => 1000 });
    await again.open(`/t/${threadId}`);
    await screen.findByText(/Upload interrupted$/);
    expect((await readQueue(again)).messages).toEqual([]);
    await userEvent.click(interruptedActions());
    await waitFor(async () =>
      expect((await readQueue(again)).messages.map((entry) => entry.input)).toEqual([
        [{ type: "text", text: "B behind A" }],
        [{ type: "text", text: "C behind B" }],
      ]),
    );
    // Remove releases what the dropped message had uploaded; that request follows the queue's.
    await waitFor(async () =>
      expect(
        (
          await again.client.request({
            type: "context.request",
            operation: { op: "attachment.list", threadId },
          })
        ).result,
      ).toMatchObject({ kind: "attachments", attachments: [] }),
    );
  } finally {
    release.resolve();
  }
});

test("an upload past its injected-clock timeout cannot send after late completion", async () => {
  let wall = 1000;
  const { app, message } = await openBusy({ uiClock: () => wall });
  const { file, entered, release } = stalledImage();
  try {
    await userEvent.upload(screen.getByLabelText("Files to attach"), file);
    await entered.promise;
    await userEvent.type(message, "A timed out{Enter}B after A{Enter}");
    wall += uploadTimeoutMs;
    fireEvent(document, new Event("visibilitychange"));
    await screen.findByText(/Upload interrupted$/);
    interruptedActions();
    release.resolve();
    await waitFor(async () =>
      expect(
        (
          await app.client.request({
            type: "context.request",
            operation: { op: "attachment.list", threadId },
          })
        ).result,
      ).toMatchObject({
        kind: "attachments",
        attachments: [expect.objectContaining({ name: "pasted.png" })],
      }),
    );
    expect((await readQueue(app)).messages).toEqual([]);
    await userEvent.click(interruptedActions());
    await waitFor(async () =>
      expect((await readQueue(app)).messages.map((entry) => entry.input)).toEqual([
        [{ type: "text", text: "B after A" }],
      ]),
    );
    expect(
      (
        await app.client.request({
          type: "context.request",
          operation: { op: "attachment.list", threadId },
        })
      ).result,
    ).toMatchObject({ kind: "attachments", attachments: [] });
  } finally {
    release.resolve();
  }
});
async function openBusy(options: Parameters<typeof harness>[0] = {}) {
  const app = harness(options);
  app
    .play({
      thread: { id: threadId, workspaceId: "ace", title: "Queue files", provider: "codex" },
      steps: [
        {
          kind: "facts",
          label: "busy",
          facts: [
            facts.rootAgent("codex"),
            facts.turn("root"),
            facts.message("root", "ask", "user", "Original prompt"),
          ],
        },
      ],
    })
    .runThrough("busy");
  await app.open(`/t/${threadId}`);
  return { app, message: await screen.findByRole("combobox", { name: "Message" }) };
}

test("a file followed by a pasted image stays in the draft and queues both without synthetic text", async () => {
  const { app, message } = await openBusy();
  await userEvent.upload(
    screen.getByLabelText("Files to attach"),
    new File(["notes"], "notes.txt", { type: "text/plain" }),
  );
  fireEvent.paste(message, { clipboardData: { files: [image()], items: [] } });
  const chips = await screen.findByRole("list", { name: "Attachments" });
  await waitFor(() => expect(within(chips).queryByRole("progressbar")).toBeNull());
  expect(within(chips).getByRole("button", { name: "Remove notes.txt" })).toBeTruthy();
  expect(within(chips).getByRole("button", { name: "Remove pasted.png" })).toBeTruthy();
  expect((await readQueue(app)).total).toBe(0);
  await userEvent.click(screen.getByRole("button", { name: "Queue message" }));
  await waitFor(async () => {
    const queue = await readQueue(app);
    expect(queue.messages[0]?.input).toEqual([{ type: "text", text: "" }]);
    expect(queue.messages[0]?.context?.attachments).toHaveLength(2);
  });
  const files = await screen.findByRole("group", { name: "Queued attachments" });
  expect(within(files).getByRole("button", { name: "Preview notes.txt" })).toBeTruthy();
  expect(within(files).getByRole("button", { name: "Preview pasted.png" })).toBeTruthy();
});

test("a failed image upload blocks queueing, and retry retains the file already attached", async () => {
  const { app, message } = await openBusy();
  await userEvent.upload(
    screen.getByLabelText("Files to attach"),
    new File(["notes"], "notes.txt", { type: "text/plain" }),
  );
  await waitFor(() => expect(screen.queryByRole("progressbar")).toBeNull());
  app.daemon.failRequests("context.request");
  fireEvent.paste(message, { clipboardData: { files: [image()], items: [] } });
  const retry = await screen.findByRole("button", { name: "Retry pasted.png" });
  await userEvent.click(screen.getByRole("button", { name: "Queue message" }));
  app.daemon.restoreRequests();
  expect((await readQueue(app)).total).toBe(0);
  await userEvent.click(retry);
  await waitFor(() => expect(screen.queryByRole("progressbar")).toBeNull());
  expect(screen.getByRole("button", { name: "Remove notes.txt" })).toBeTruthy();
  await userEvent.type(message, "Read both{Enter}");
  await waitFor(async () =>
    expect((await readQueue(app)).messages[0]?.context?.attachments).toHaveLength(2),
  );
});

test("offline queued attachments survive replacing the client and arrive once in order after reconnect", async () => {
  const outbox = memoryStorage();
  const { app, message } = await openBusy({ outbox });
  await userEvent.upload(screen.getByLabelText("Files to attach"), image());
  await waitFor(() => expect(screen.queryByRole("progressbar")).toBeNull());
  act(() => app.daemon.refuseConnections(true));
  await waitFor(() => expect(app.client.state).not.toBe("ready"));
  await userEvent.type(message, "First with image{Enter}Then second{Enter}");
  await waitFor(() =>
    expect(
      app.client
        .pendingSends(threadId)
        .getSnapshot()
        .filter((send) => send.state === "sent"),
    ).toHaveLength(2),
  );
  cleanup();
  await app.client.close();
  reloadPage();
  resetSendStore();
  app.daemon.refuseConnections(false);
  const again = harness({ daemon: app.daemon, storage: app.storage, outbox });
  await again.open(`/t/${threadId}`);
  await waitFor(async () => {
    const queue = await readQueue(again);
    expect(queue.messages.map((entry) => entry.input)).toEqual([
      [{ type: "text", text: "First with image" }],
      [{ type: "text", text: "Then second" }],
    ]);
    expect(queue.messages[0]?.context?.attachments).toHaveLength(1);
  });
  expect(await screen.findByRole("button", { name: "Preview pasted.png" })).toBeTruthy();
  act(() => app.daemon.disconnectAll());
  await waitFor(() => expect(again.client.state).toBe("ready"));
  expect((await readQueue(again)).total).toBe(2);
});

test("an edit keeps unsaved wording when the turn ends and its original attachments dispatch", async () => {
  const { app, message } = await openBusy();
  await userEvent.upload(screen.getByLabelText("Files to attach"), image());
  await userEvent.type(message, "Original wording{Enter}");
  const edit = await screen.findByRole("button", { name: "Edit queued message" });
  await waitFor(() => expect(edit.hasAttribute("disabled")).toBe(false));
  await userEvent.click(edit);
  const editor = await screen.findByRole("textbox", { name: "Queued message text" });
  await userEvent.clear(editor);
  await userEvent.type(editor, "Keep my revision");
  act(() => app.daemon.apply(threadId, [facts.endTurn("root")]));
  await screen.findByText("This message has left the queue. Your edits are still here to copy.");
  expect(editor).toHaveProperty("value", "Keep my revision");
  expect(screen.getByRole("button", { name: "Save changes" }).hasAttribute("disabled")).toBe(true);
  const view = app.daemon.snapshot({ kind: "thread", threadId });
  if (!view || !("items" in view)) throw new Error("Missing transcript");
  const sent = Object.values(view.items).filter(
    (item) => item.type === "message" && item.role === "user" && item.attachments?.length,
  );
  expect(sent).toHaveLength(1);
  expect(sent[0]?.type === "message" ? sent[0].parts : []).toEqual([
    { type: "text", text: "Original wording" },
  ]);
});

test("an unfinished image submission keeps a later text message behind it through turn completion", async () => {
  const { app, message } = await openBusy();
  const file = image();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const slice = file.slice.bind(file);
  file.slice = (start, end, type) => {
    const part = slice(start, end, type);
    const read = part.arrayBuffer.bind(part);
    part.arrayBuffer = async () => {
      entered.resolve();
      await release.promise;
      return read();
    };
    return part;
  };
  try {
    await userEvent.upload(screen.getByLabelText("Files to attach"), file);
    await entered.promise;
    await userEvent.type(message, "A with unfinished image{Enter}B after image{Enter}");
    act(() => app.daemon.apply(threadId, [facts.endTurn("root")]));
    const before = app.daemon.snapshot({ kind: "thread", threadId });
    if (!before || !("items" in before)) throw new Error("Missing transcript");
    expect(
      Object.values(before.items).filter(
        (item) =>
          item.type === "message" &&
          item.parts.some((part) => part.type === "text" && /^(A with|B after)/.test(part.text)),
      ),
    ).toEqual([]);
    release.resolve();
    const feed = await screen.findByRole("feed", { name: "Transcript" });
    await within(feed).findByText("A with unfinished image");
    await waitFor(async () =>
      expect((await readQueue(app)).messages.map((entry) => entry.input)).toEqual([
        [{ type: "text", text: "B after image" }],
      ]),
    );
    await within(await screen.findByRole("list", { name: "Queued messages" })).findByText(
      "B after image",
    );
    await waitFor(() => expect(within(feed).queryByText("B after image")).toBeNull());
    act(() =>
      app.daemon.apply(threadId, [{ type: "turn.ended", agent: "root", outcome: "completed" }]),
    );
    const second = await within(feed).findByText("B after image");
    expect(
      within(feed).getByText("A with unfinished image").compareDocumentPosition(second) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect((await readQueue(app)).total).toBe(0);
  } finally {
    release.resolve();
  }
});

test.each(["text-only", "uploaded attachment"])(
  "Retry after a failed outbox save and reload delivers a %s predecessor and its successors in order",
  async (payload) => {
    const outbox = memoryStorage();
    let refuse = false;
    const heldOutbox = {
      load: outbox.load,
      save: async (value: string) => {
        if (refuse) throw new Error("device full");
        await outbox.save(value);
      },
    };
    const { app, message } = await openBusy({ outbox: heldOutbox });
    let uploadedHash: string | undefined;
    if (payload === "uploaded attachment") {
      await userEvent.upload(screen.getByLabelText("Files to attach"), image());
      await waitFor(() => expect(screen.queryByRole("progressbar")).toBeNull());
      const { result } = await app.client.request({
        type: "context.request",
        operation: { op: "attachment.list", threadId },
      });
      if (result.kind !== "attachments") throw new Error("Missing uploaded attachment list");
      uploadedHash = result.attachments.find((file) => file.name === "pasted.png")?.sha256;
      if (!uploadedHash) throw new Error("Image did not finish uploading");
    }
    refuse = true;
    await userEvent.type(message, "First waiting on device storage{Enter}");
    await screen.findByRole("button", { name: "Retry" });
    await userEvent.type(message, "Second behind the first{Enter}");
    await screen.findByText("Waiting for an earlier message…");
    expect((await readQueue(app)).total).toBe(0);
    const retained = stagedSends(app.storage).get();
    const ids = retained.map((entry) => entry.commandId);
    cleanup();
    await app.client.close();
    reloadPage();
    resetSendStore();
    refuse = false;
    const again = harness({ daemon: app.daemon, storage: app.storage, outbox });
    await again.open(`/t/${threadId}`);
    await userEvent.click(await screen.findByRole("button", { name: "Retry" }));
    await waitFor(async () => {
      const queue = await readQueue(again);
      expect(queue.messages.map((entry) => entry.input)).toEqual([
        [{ type: "text", text: "First waiting on device storage" }],
        [{ type: "text", text: "Second behind the first" }],
      ]);
      expect(queue.messages.map((entry) => entry.id)).toEqual(ids);
      expect(queue.messages[0]?.context?.attachments).toEqual(
        uploadedHash ? [{ sha256: uploadedHash }] : [],
      );
    });
    expect(screen.queryByText(/Upload interrupted$/)).toBeNull();
  },
);
