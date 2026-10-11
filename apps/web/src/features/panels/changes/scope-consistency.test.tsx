import { coldStartReplay } from "@ace/fake-daemon";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, onTestFinished, test } from "vitest";
import { harness } from "@/test/harness.tsx";

beforeEach(() => localStorage.clear());

async function openChanges(app = harness()) {
  app.play(coldStartReplay()).runThrough("turn-2");
  await app.open("/t/thread-cold-start");
  await screen.findByRole("feed", { name: "Transcript" });
  await userEvent.click(screen.getByRole("button", { name: "Right panel" }));
  const panel = await screen.findByRole("region", { name: "Thread panel" });
  await userEvent.click(within(panel).getByRole("tab", { name: /^Changes/ }));
  await within(panel).findByRole("region", { name: "apps/server/src/replay.ts" });
  return panel;
}

async function pick(panel: HTMLElement, name: string) {
  await userEvent.click(within(panel).getByRole("button", { name: /^Scope:/ }));
  await userEvent.click(await screen.findByRole("menuitemradio", { name }));
}

function expectTotal(panel: HTMLElement, added: number, removed: number) {
  expect(within(panel).getByRole("tab", { name: /^Changes/ }).textContent).toBe("Changes");
  expect(within(panel).getByRole("toolbar", { name: "Changes" }).textContent).toContain(
    `+${added} −${removed}`,
  );
}

test("the Changes toolbar counts the selected turn and keeps it when another tab opens", async () => {
  const panel = await openChanges();
  await waitFor(() => expectTotal(panel, 9, 3));
  await pick(panel, "This thread");
  await waitFor(() => expectTotal(panel, 17, 5));
  await pick(panel, "Turn 1");
  await waitFor(() => expectTotal(panel, 8, 2));
  await userEvent.click(within(panel).getByRole("tab", { name: "Agents" }));
  await userEvent.click(within(panel).getByRole("tab", { name: /^Changes/ }));
  expect(within(panel).getByRole("button", { name: "Scope: Turn 1" })).toBeTruthy();
  await waitFor(() => expectTotal(panel, 8, 2));
  await userEvent.click(screen.getByRole("button", { name: /^Work card/ }));
  const card = await screen.findByRole("complementary", { name: "Work card" });
  expect(
    within(card).getByRole("button", { name: "Changes, 2 files: 38 added, 6 removed" }),
  ).toBeTruthy();
});

test("uncommitted totals come from the live checkout and stay selected across tabs", async () => {
  const app = harness();
  app.daemon.workspace.setGitDiff(
    "thread-cold-start",
    "diff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n@@ -1,2 +1,3 @@\n Keep\n-Old line\n+First new line\n+Second new line\n",
  );
  const panel = await openChanges(app);
  expect(within(panel).queryByRole("status", { name: "Working tree" })).toBeNull();
  await pick(panel, "Uncommitted");
  expect((await within(panel).findByLabelText("Uncommitted diff")).textContent).toContain(
    "+First new line",
  );
  await waitFor(() => expectTotal(panel, 2, 1));
  expect(within(panel).getByRole("button", { name: "Scope: Uncommitted" })).toBeTruthy();
  await userEvent.click(within(panel).getByRole("tab", { name: "Agents" }));
  await userEvent.click(within(panel).getByRole("tab", { name: /^Changes/ }));
  expect(within(panel).getByRole("button", { name: "Scope: Uncommitted" })).toBeTruthy();
  await waitFor(() => expectTotal(panel, 2, 1));
});

test("diff comment controls explain the old or new line on hover and open a comment", async () => {
  const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetWidth");
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
    configurable: true,
    get: () => 1000,
  });
  onTestFinished(() => {
    if (original) Object.defineProperty(HTMLElement.prototype, "offsetWidth", original);
  });
  const panel = await openChanges();
  for (const layout of ["Unified", "Split"] as const) {
    await userEvent.click(within(panel).getByRole("button", { name: "Diff options" }));
    await userEvent.click(
      await screen.findByRole("menuitemradio", { name: new RegExp(`^${layout}`) }),
    );
    for (const old of [true, false]) {
      const buttons = within(panel).getAllByRole("button", {
        name: old ? /^Comment on old line \d+$/ : /^Comment on line \d+$/,
      });
      const button = buttons[0];
      if (!button) throw new Error("Missing comment control");
      const label = button.getAttribute("aria-label") ?? "";
      await userEvent.hover(button);
      expect((await screen.findByRole("tooltip")).textContent).toBe(label);
      await userEvent.unhover(button);
      await userEvent.click(button);
      expect(within(panel).getByRole("textbox", { name: label })).toBeTruthy();
      await userEvent.click(within(panel).getByRole("button", { name: "Cancel" }));
    }
  }
});
