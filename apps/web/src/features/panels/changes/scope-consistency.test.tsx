import { coldStartReplay } from "@ace/fake-daemon";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, onTestFinished, test } from "vitest";
import { harness } from "@/test/harness.tsx";

beforeEach(() => localStorage.clear());

async function openChanges() {
  const app = harness();
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
  expect(within(panel).getByRole("tab", { name: /^Changes/ }).textContent).toContain(
    `+${added} −${removed}`,
  );
  expect(within(panel).getByRole("toolbar", { name: "Changes" }).textContent).toContain(
    `+${added} −${removed}`,
  );
}

test("the Changes badge and toolbar count the selected turn and keep it when another tab opens", async () => {
  const panel = await openChanges();
  await waitFor(() => expectTotal(panel, 9, 3));
  await pick(panel, "All turns");
  await waitFor(() => expectTotal(panel, 17, 5));
  await pick(panel, "Turn 1");
  await waitFor(() => expectTotal(panel, 8, 2));
  await userEvent.click(within(panel).getByRole("tab", { name: "Agents" }));
  await userEvent.click(within(panel).getByRole("tab", { name: /^Changes/ }));
  expect(within(panel).getByRole("button", { name: "Scope: Turn 1" })).toBeTruthy();
  await waitFor(() => expectTotal(panel, 8, 2));
  await userEvent.click(screen.getByRole("button", { name: "Work card" }));
  const card = await screen.findByRole("dialog", { name: "Work card" });
  expect(
    within(card).getByRole("button", { name: "Changes, turn 1: 8 added, 2 removed" }),
  ).toBeTruthy();
});

test("uncommitted totals identify the checkout and become the Changes badge when selected", async () => {
  const panel = await openChanges();
  const status = within(panel).getByRole("status", { name: "Working tree" });
  expect(status.textContent).toContain("Uncommitted:+38 −6");
  await pick(panel, "Uncommitted");
  await waitFor(() =>
    expect(within(panel).getByRole("tab", { name: /^Changes/ }).textContent).toContain("+38 −6"),
  );
  expect(within(panel).getByRole("button", { name: "Scope: Uncommitted" })).toBeTruthy();
  await userEvent.click(within(panel).getByRole("tab", { name: "Agents" }));
  await userEvent.click(within(panel).getByRole("tab", { name: /^Changes/ }));
  expect(within(panel).getByRole("button", { name: "Scope: Uncommitted" })).toBeTruthy();
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
    await userEvent.click(within(panel).getByRole("button", { name: /^Diff layout:/ }));
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
