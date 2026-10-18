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

test("⌘Z outside a text field takes back the latest settle; inside one it is the field's", async () => {
  const app = harness();
  for (const scenario of workbench()) app.play(scenario).runUntilBlocked();
  await app.open("/");
  const list = await screen.findByRole("list", { name: "Threads" });
  const settle = (
    await within(list).findAllByRole("button", { name: /^Settle /, hidden: true })
  )[0];
  if (!settle) throw new Error("A row must offer Settle");
  const title = settle.getAttribute("aria-label")?.replace(/^Settle /, "") ?? "";
  await userEvent.click(settle);
  const done = `Settled · ${title}`;
  await screen.findByText(done);

  await userEvent.click(screen.getByRole("searchbox", { name: "Search threads" }));
  await userEvent.keyboard("{Control>}z{/Control}");
  expect(screen.queryByText(done)).toBeTruthy();

  document.getElementById("main")?.focus();
  await userEvent.keyboard("{Control>}z{/Control}");
  await waitFor(() => expect(screen.queryByText(done)).toBeNull());
  // Back among the threads in hand, with its Settle button again.
  await waitFor(() =>
    expect(
      within(list).getAllByRole("button", { name: `Settle ${title}`, hidden: true }),
    ).toHaveLength(1),
  );
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
