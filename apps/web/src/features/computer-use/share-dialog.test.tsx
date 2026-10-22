import { flakyCheckout } from "@ace/fake-daemon";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test } from "vitest";
import { deviceBrowser } from "@/test/device-browser.ts";
import { harness } from "@/test/harness.tsx";
import { screenWorld } from "@/test/screen-world.ts";

// A Linux desktop on Wayland: nothing to list, the machine's own sharing dialog picks.
let browser: ReturnType<typeof deviceBrowser>;
beforeEach(() => {
  browser = deviceBrowser("decodes");
});
afterEach(() => browser.restore());

async function openSharing() {
  const app = harness();
  app.play(flakyCheckout()).runThrough("explorer-spawned");
  const world = screenWorld(app.daemon, "thread-checkout");
  app.daemon.screen.enabled = true;
  app.daemon.screen.sharingDialog = true;
  await app.open("/t/thread-checkout");
  await userEvent.keyboard("{Control>}{Shift>}m{/Shift}{/Control}");
  const panel = await screen.findByRole("region", { name: "Thread panel" });
  if (!within(panel).queryByRole("button", { name: /^Share a/ })) {
    await userEvent.click(within(panel).getByRole("button", { name: "New tab" }));
    const tools = await within(panel).findByRole("list", { name: "Tools" });
    await userEvent.click(within(tools).getByRole("button", { name: /^Computer use/ }));
  }
  // The button names what it shares once the machine says its dialog picks.
  await userEvent.click(
    await within(panel).findByRole("button", { name: "Share a window or screen…" }),
  );
  const dialog = await screen.findByRole("dialog", { name: "Share a window or screen" });
  await userEvent.click(
    await within(dialog).findByRole("button", { name: "Open the sharing dialog" }),
  );
  return { app, world, panel, dialog };
}

test("sharing on a desktop whose dialog picks waits for the person there, then the window is live", async () => {
  const { app, world, panel, dialog } = await openSharing();
  // Waiting, in words, here and on the session's card, until the person chooses there.
  expect(
    (await within(dialog).findByRole("status")).textContent?.startsWith("Waiting for approval on"),
  ).toBe(true);
  expect(within(dialog).getByText(/choose the window in the sharing dialog there/)).toBeTruthy();
  // The person can close the picker: the session's card keeps saying it waits, with Cancel.
  await userEvent.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  const card = await within(panel).findByRole("article", { name: "Window or screen" });
  expect(within(card).getByRole("status").textContent).toMatch(
    /^Waiting for approval on .+ there\.$/,
  );
  expect(within(card).getByRole("button", { name: "Cancel" })).toBeTruthy();
  expect(within(card).queryByRole("button", { name: /Take over/ })).toBeNull();

  app.daemon.screen.answerSharingDialog({
    source: "window",
    bundleId: "org.gnome.Calculator",
    title: "Calculator",
  });
  await waitFor(async () =>
    expect(await world.sessions()).toEqual([
      expect.objectContaining({
        lifecycle: "live",
        controller: "agent",
        target: expect.objectContaining({ picked: expect.objectContaining({ source: "window" }) }),
      }),
    ]),
  );
  // Named by the app the person picked, and a person can take it over.
  const live = await within(panel).findByRole("article", { name: "Calculator" });
  expect(within(live).getByRole("button", { name: /Take over/ })).toBeTruthy();
});

test("a shared screen is watch-only: nobody can take it over", async () => {
  const { app, panel } = await openSharing();
  app.daemon.screen.answerSharingDialog({ source: "display" });
  const card = await within(panel).findByRole("article", { name: "Shared screen" });
  await waitFor(() => expect(within(card).getByRole("status").textContent).toMatch(/Watch only/));
  expect(within(card).queryByRole("button", { name: /Take over/ })).toBeNull();
});

test("a declined sharing dialog is said in a sentence and nothing keeps running", async () => {
  const { app, world, dialog } = await openSharing();
  await within(dialog).findByRole("status");
  app.daemon.screen.answerSharingDialog("declined");
  expect((await within(dialog).findByRole("alert")).textContent).toBe(
    "Sharing was declined in the sharing dialog.",
  );
  expect(within(dialog).getByRole("button", { name: "Try again" })).toBeTruthy();
  expect(await world.sessions()).toEqual([]);
});

test("Cancel while the machine's dialog waits ends the wait without a complaint", async () => {
  const { world, dialog } = await openSharing();
  await within(dialog).findByRole("status");
  await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
  await waitFor(async () => expect(await world.sessions()).toEqual([]));
  expect(within(dialog).queryByRole("alert")).toBeNull();
});
