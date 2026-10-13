import { longHistory } from "@ace/fake-daemon";
import { ThreadId } from "@ace/protocol";
import { act, cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";
import { harness, memoryKeyValue } from "@/test/harness.tsx";
import { resetDismissed } from "./composer/dismissed-sends.ts";
import { resetSendStore } from "./composer/send-store.ts";
import { reloadPage, resetStaged } from "./composer/staged-sends.ts";

/*
 * A message sent while its files upload (UX audit SY-2, AT-2; review of #126): it waits as its
 * bubble, is kept on this device, goes once the files are up, and never disappears: an upload
 * that fails, or a page that closes mid-upload, leaves it as a failed bubble with Retry and
 * Edit, whatever the composer holds by then.
 */

beforeEach(() => {
  localStorage.clear();
  resetSendStore();
  resetDismissed();
  resetStaged();
});
const png = () =>
  new File([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], "screen.png", {
    type: "image/png",
  });

async function open(storage = memoryKeyValue()) {
  const app = harness({ storage });
  app.play(longHistory(2)).runUntilBlocked();
  await app.open("/t/thread-router");
  const feed = await screen.findByRole("feed", { name: "Transcript" });
  const message = (await screen.findByRole("combobox", { name: "Message" })) as HTMLDivElement;
  return { app, feed, message, storage };
}

/** The person's message as the daemon holds it, once it has it. */
function delivered(app: ReturnType<typeof harness>) {
  const view = app.daemon.snapshot({ kind: "thread", threadId: ThreadId.parse("thread-router") });
  if (view?.kind !== "thread") return undefined;
  return Object.values(view.items).find(
    (item) =>
      item.type === "message" &&
      item.parts.some((part) => part.type === "text" && part.text === "Why is this banner orange?"),
  );
}

/** Attach an image the daemon is slow to take, and send with it before it's up. */
async function sendWhileUploading(app: ReturnType<typeof harness>, message: HTMLDivElement) {
  app.daemon.holdRequests("context.request");
  await userEvent.upload(screen.getByLabelText("Files to attach"), png());
  await userEvent.type(message, "Why is this banner orange?{Enter}");
}

/**
 * Send with an image whose bytes can't be read until `finish()`, so its upload completes
 * exactly then. (A held request is never answered, so it can't stand in for a slow one.)
 */
async function sendWhileReading(message: HTMLDivElement) {
  const file = png();
  const gate = Promise.withResolvers<void>();
  const slice = file.slice.bind(file);
  file.slice = (start, end, type) => {
    const part = slice(start, end, type);
    const read = part.arrayBuffer.bind(part);
    part.arrayBuffer = async () => {
      await gate.promise;
      return read();
    };
    return part;
  };
  await userEvent.upload(screen.getByLabelText("Files to attach"), file);
  await userEvent.type(message, "Why is this banner orange?{Enter}");
  return { finish: () => gate.resolve() };
}

test("an upload that fails after Enter leaves the message as a failed bubble, and Retry delivers it", async () => {
  const { app, feed, message } = await open();
  await sendWhileUploading(app, message);
  expect(await within(feed).findByText("Uploading an image…")).toBeTruthy();
  // The person moves on: the next draft is already in the composer.
  await userEvent.type(message, "And the footer colour");

  // The connection drops mid-upload, so the upload fails.
  act(() => app.daemon.disconnectAll());
  const alert = await within(feed).findByRole("alert");
  expect(within(alert).getByText(/screen\.png didn't upload/)).toBeTruthy();
  expect(within(feed).getByText("Why is this banner orange?")).toBeTruthy();
  expect(message.textContent).toBe("And the footer colour");

  app.daemon.restoreRequests();
  await waitFor(() => expect(app.client.state).toBe("ready"));
  await userEvent.click(within(alert).getByRole("button", { name: "Retry" }));
  // Delivered: the daemon has the message with its image, and it shows once.
  await waitFor(() =>
    expect(delivered(app)).toMatchObject({ attachments: [{ name: "screen.png" }] }),
  );
  await waitFor(() => expect(within(feed).queryByRole("alert")).toBeNull());
  expect(within(feed).queryByText("Uploading an image…")).toBeNull();
  expect(within(feed).getAllByText("Why is this banner orange?")).toHaveLength(1);
});

test("Edit on a failed held message gives back its text, beside what the composer holds", async () => {
  const { app, feed, message } = await open();
  await sendWhileUploading(app, message);
  await userEvent.type(message, "And the footer colour");
  act(() => app.daemon.disconnectAll());
  const alert = await within(feed).findByRole("alert");

  await userEvent.click(within(alert).getByRole("button", { name: "Edit" }));
  await waitFor(() =>
    expect((screen.getByRole("combobox", { name: "Message" }) as HTMLDivElement).textContent).toBe(
      "And the footer colour\n\nWhy is this banner orange?",
    ),
  );
  expect(within(feed).queryByText("Why is this banner orange?")).toBeNull();
});

test("a message held for its uploads survives a reload, as a failed bubble saying why", async () => {
  const first = await open();
  await sendWhileUploading(first.app, first.message);
  expect(await within(first.feed).findByText("Uploading an image…")).toBeTruthy();

  cleanup();
  reloadPage();
  const again = await open(first.storage);
  const alert = await within(again.feed).findByRole("alert");
  expect(within(alert).getByText(/Upload interrupted$/)).toBeTruthy();
  expect(within(again.feed).getByText("Why is this banner orange?")).toBeTruthy();
  // Reload never offers to reconstruct or resend an unfinished upload.
  expect(within(alert).queryByRole("button", { name: "Retry" })).toBeNull();
  expect(within(alert).queryByRole("button", { name: "Edit" })).toBeNull();
  expect(within(alert).getByRole("button", { name: "Remove" })).toBeTruthy();
});

test("a staged storage refusal keeps the text and uploading file in the composer", async () => {
  const backing = memoryKeyValue();
  const storage = {
    ...backing,
    setItem(key: string, value: string) {
      if (key.startsWith("ace.sends.staged")) throw new Error("quota");
      backing.setItem(key, value);
    },
  };
  const { app, message } = await open(storage);
  await sendWhileUploading(app, message);
  await screen.findByRole("heading", { name: "Message not sent" });
  await waitFor(() =>
    expect(screen.getByRole("combobox", { name: "Message" }).textContent).toBe(
      "Why is this banner orange?",
    ),
  );
  expect(screen.getByRole("button", { name: "Remove screen.png" })).toBeTruthy();
});

test("a completion storage refusal exposes Retry and Edit, and Retry sends the already uploaded file", async () => {
  const backing = memoryKeyValue();
  let full = false;
  const storage = {
    ...backing,
    get length() {
      return backing.data.size;
    },
    setItem(key: string, value: string) {
      if (full && key.startsWith("ace.sends.staged")) throw new Error("quota");
      backing.setItem(key, value);
    },
  };
  const { app, feed, message } = await open(storage);
  const upload = await sendWhileReading(message);
  expect(await within(feed).findByText("Uploading an image…")).toBeTruthy();
  full = true;
  act(() => upload.finish());
  const alert = await within(feed).findByRole("alert");
  expect(within(alert).getByText(/This device couldn't save the upload results/)).toBeTruthy();
  expect(within(alert).getByRole("button", { name: "Retry" })).toBeTruthy();
  expect(within(alert).getByRole("button", { name: "Edit" })).toBeTruthy();
  expect(within(feed).queryByText("Uploading an image…")).toBeNull();
  expect(delivered(app)).toBeUndefined();

  // A second refusal stays actionable. No new context requests may finish: Retry must reuse
  // the daemon's completed upload, rather than trying to upload the original File again.
  app.daemon.holdRequests("context.request");
  await userEvent.click(within(alert).getByRole("button", { name: "Retry" }));
  await screen.findByRole("heading", { name: "It still didn't go" });
  expect(within(feed).queryByText("Uploading an image…")).toBeNull();
  expect(within(feed).getByRole("button", { name: "Edit" })).toBeTruthy();
  full = false;
  await userEvent.click(within(feed).getByRole("button", { name: "Retry" }));
  await waitFor(() =>
    expect(delivered(app)).toMatchObject({ attachments: [{ name: "screen.png" }] }),
  );
  expect(within(feed).queryByRole("alert")).toBeNull();
});

test.each([false, true])(
  "Edit keeps the recovery bubble and full draft when deletion is refused, including draft write refusal: %s",
  async (refuseDraft) => {
    const backing = memoryKeyValue();
    let full = false;
    const storage = {
      ...backing,
      get length() {
        return backing.data.size;
      },
      removeItem(key: string) {
        if (full && key.startsWith("ace.sends.staged")) throw new Error("quota");
        backing.removeItem?.(key);
      },
      setItem(key: string, value: string) {
        if (
          full &&
          (key.startsWith("ace.sends.staged") || (refuseDraft && key === "ace.composer.drafts"))
        )
          throw new Error("quota");
        backing.setItem(key, value);
      },
    };
    const { app, feed, message } = await open(storage);
    const upload = await sendWhileReading(message);
    full = true;
    act(() => upload.finish());
    const alert = await within(feed).findByRole("alert");
    await userEvent.type(screen.getByRole("combobox", { name: "Message" }), "Newer work");
    await userEvent.click(within(alert).getByRole("button", { name: "Edit" }));
    const field = await screen.findByRole("combobox", { name: "Message" });
    await waitFor(() => expect(field.textContent).toBe("Newer work\n\nWhy is this banner orange?"));
    expect(screen.getByRole("button", { name: "Remove screen.png" })).toBeTruthy();
    expect(within(feed).getByRole("button", { name: "Save edit" })).toBeTruthy();
    expect(delivered(app)).toBeUndefined();
    await userEvent.click(within(feed).getByRole("button", { name: "Save edit" }));
    expect(field.textContent).toBe("Newer work\n\nWhy is this banner orange?");
    expect(within(feed).getByRole("button", { name: "Save edit" })).toBeTruthy();
    full = false;
    await userEvent.click(within(feed).getByRole("button", { name: "Save edit" }));
    await waitFor(() => expect(within(feed).queryByRole("alert")).toBeNull());
    cleanup();
    await app.open("/t/thread-router");
    expect((await screen.findByRole("combobox", { name: "Message" })).textContent).toBe(
      "Newer work\n\nWhy is this banner orange?",
    );
    expect(screen.getByRole("button", { name: "Remove screen.png" })).toBeTruthy();
  },
);
