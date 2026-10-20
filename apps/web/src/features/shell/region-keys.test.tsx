import { replayCursor, workbench } from "@ace/fake-daemon";
import type { CommandPayload } from "@ace/protocol";
import { configure, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";
import { resetDismissed } from "@/features/thread/composer/dismissed-sends.ts";
import { resetSendStore } from "@/features/thread/composer/send-store.ts";
import { resetStops } from "@/features/thread/composer/stop-state.ts";
import { stepRegion } from "./regions.ts";

configure({ asyncUtilTimeout: 10000 });

beforeEach(() => {
  resetDismissed();
  resetSendStore();
  resetStops();
});

// jsdom is a non-Apple browser tab: "mod" is Ctrl.

test("F6 skips a region that isn't on screen and wraps from the composer back to the list", () => {
  const shown = ["sidebar", "main", "composer"] as const;
  expect(stepRegion(shown, "main", 1)).toBe("composer");
  expect(stepRegion(shown, "composer", 1)).toBe("sidebar");
  expect(stepRegion(shown, "sidebar", -1)).toBe("composer");
  expect(stepRegion([...shown, "panel"], "main", 1)).toBe("panel");
  // From the page itself, F6 starts at the first region and ⇧F6 at the last.
  expect(stepRegion(shown, undefined, 1)).toBe("sidebar");
  expect(stepRegion(shown, undefined, -1)).toBe("composer");
});

async function openThread() {
  const app = harness();
  for (const scenario of workbench()) app.play(scenario).runUntilBlocked();
  await app.open("/t/thread-refund-tax");
  const message = await screen.findByRole("combobox", { name: "Message" });
  const threads = await screen.findByRole("navigation", { name: "Threads" });
  await within(threads).findAllByRole("link");
  return { app, message, threads };
}

test("F6 walks the thread list, the main view and the composer, and ⇧F6 walks back", async () => {
  const { message, threads } = await openThread();
  await userEvent.click(message);

  await userEvent.keyboard("{F6}");
  await waitFor(() => expect(threads.contains(document.activeElement)).toBe(true));
  await userEvent.keyboard("{F6}");
  expect(document.activeElement).toBe(document.getElementById("main"));
  await userEvent.keyboard("{F6}");
  expect(document.activeElement).toBe(message);

  await userEvent.keyboard("{Shift>}{F6}{/Shift}");
  expect(document.activeElement).toBe(document.getElementById("main"));
});

test("the thread list and the composer each have a key that focuses them from anywhere", async () => {
  const { message, threads } = await openThread();
  await userEvent.click(message);

  await userEvent.keyboard("{Control>}{Shift>}e{/Shift}{/Control}");
  await waitFor(() => expect(threads.contains(document.activeElement)).toBe(true));
  expect(document.activeElement?.getAttribute("tabindex")).toBe("0");

  await userEvent.keyboard("{Control>}{Alt>}l{/Alt}{/Control}");
  expect(document.activeElement).toBe(message);
});

test("⌘Z outside a text field takes back the latest archive; inside one it is the field's", async () => {
  const app = harness();
  for (const scenario of workbench()) app.play(scenario).runUntilBlocked();
  await app.open("/");
  const archivedAt = () => {
    const view = app.daemon.snapshot({ kind: "threads" });
    return view?.kind === "threads" ? view.threads["thread-pdf-locale"]?.archivedAt : undefined;
  };
  const threads = await screen.findByRole("navigation", { name: "Threads" });
  const row = () => within(threads).queryByRole("link", { name: /^Invoice PDF locale fallback/ });
  const target = await within(threads).findByRole("link", { name: /^Invoice PDF locale fallback/ });
  await userEvent.pointer({ keys: "[MouseRight]", target });
  const menu = await screen.findByRole("menu", { name: /^Actions for/ });
  await userEvent.click(within(menu).getByRole("menuitem", { name: "Archive" }));
  const done = "Archived · Invoice PDF locale fallback";
  await screen.findByText(done);
  await waitFor(() => expect(archivedAt()).toBeDefined());
  await waitFor(() => expect(row()).toBeNull());

  // The palette's search is a text field: ⌘Z there is the field's own.
  await userEvent.keyboard("{Control>}k{/Control}");
  const palette = await screen.findByRole("dialog", { name: "Command palette" });
  const field = within(palette).getByRole("combobox", { name: "Search commands" });
  await waitFor(() => expect(document.activeElement).toBe(field));
  await userEvent.keyboard("{Control>}z{/Control}");
  expect(screen.queryByText(done)).toBeTruthy();
  expect(archivedAt()).toBeDefined();
  await userEvent.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Command palette" })).toBeNull());

  document.getElementById("main")?.focus();
  await userEvent.keyboard("{Control>}z{/Control}");
  await waitFor(() => expect(screen.queryByText(done)).toBeNull());
  // Back on the daemon and in the list.
  await waitFor(() => expect(archivedAt()).toBeUndefined());
  await waitFor(() => expect(row()).toBeTruthy());
});

test("⌘. stops the working agent tree from anywhere in the thread", async () => {
  const made = harness();
  made.play(replayCursor()).runThrough("finding");
  const sent: CommandPayload[] = [];
  const receive = made.daemon.command.bind(made.daemon);
  made.daemon.command = (command) => {
    sent.push(command.payload);
    return receive(command);
  };
  await made.open("/t/thread-replay-cursor");
  await screen.findByRole("button", { name: "Stop the agent" });
  document.getElementById("main")?.focus();

  await userEvent.keyboard("{Control>}.{/Control}");
  await waitFor(() =>
    expect(sent.filter((payload) => payload.type === "thread.interrupt")).toEqual([
      expect.objectContaining({ cascade: true }),
    ]),
  );
});
