import { longHistory } from "@ace/fake-daemon";
import { ThreadId } from "@ace/protocol";
import { act, cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test } from "vitest";
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
afterEach(() => {
  Reflect.deleteProperty(navigator, "locks");
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
  const message = (await screen.findByRole("combobox", { name: "Message" })) as HTMLTextAreaElement;
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
async function sendWhileUploading(app: ReturnType<typeof harness>, message: HTMLTextAreaElement) {
  app.daemon.holdRequests("context.request");
  await userEvent.upload(screen.getByLabelText("Files to attach"), png());
  await userEvent.type(message, "Why is this banner orange?{Enter}");
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
  expect(message.value).toBe("And the footer colour");

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
    expect((screen.getByRole("combobox", { name: "Message" }) as HTMLTextAreaElement).value).toBe(
      "And the footer colour\n\nWhy is this banner orange?",
    ),
  );
  expect(within(feed).queryByText("Why is this banner orange?")).toBeNull();
});

test("a message held for its uploads survives a reload, as a failed bubble saying why", async () => {
  // Pages hold a lock while their uploads run; after the reload nobody holds the old one.
  Object.defineProperty(navigator, "locks", {
    configurable: true,
    value: { request: () => new Promise(() => {}), query: async () => ({ held: [] }) },
  });
  const first = await open();
  await sendWhileUploading(first.app, first.message);
  expect(await within(first.feed).findByText("Uploading an image…")).toBeTruthy();

  cleanup();
  reloadPage();
  const again = await open(first.storage);
  const alert = await within(again.feed).findByRole("alert");
  expect(
    within(alert).getByText(/The page closed before screen\.png finished uploading/),
  ).toBeTruthy();
  expect(within(again.feed).getByText("Why is this banner orange?")).toBeTruthy();
  // The file didn't reach the daemon and this page doesn't have it: Edit, not Retry.
  expect(within(alert).queryByRole("button", { name: "Retry" })).toBeNull();
  expect(within(alert).getByRole("button", { name: "Edit" })).toBeTruthy();
});
