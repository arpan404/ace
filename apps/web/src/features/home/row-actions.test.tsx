import { workbench } from "@ace/fake-daemon";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

const title = "Dedupe thread events after reconnect";

async function openHome() {
  const app = harness();
  const dedupe = workbench().find((scenario) => scenario.thread.title === title);
  if (!dedupe) throw new Error(`workbench lost ${title}`);
  app.play(dedupe).runUntilBlocked();
  await app.open("/");
  const nav = await screen.findByRole("navigation", { name: "Threads" });
  await within(nav).findAllByRole("link");
  return app;
}

test("Snooze and Pin are available from the task context menu", async () => {
  await openHome();
  const row = within(screen.getByRole("navigation", { name: "Threads" })).getByRole("link", {
    name: /^Dedupe/,
  });
  if (!row) throw new Error("no task");
  await userEvent.pointer({ keys: "[MouseRight]", target: row });
  await userEvent.hover(await screen.findByRole("menuitem", { name: /^Snooze/ }));
  expect(await screen.findByRole("menuitem", { name: /^Tomorrow/ })).toBeTruthy();
  await userEvent.keyboard("{Escape}");
  await userEvent.click(screen.getByRole("menuitem", { name: /^Pin/ }));
  await waitFor(() => expect(screen.getByRole("link", { name: /^Dedupe.*Pinned/ })).toBeTruthy());
  await userEvent.pointer({
    keys: "[MouseRight]",
    target: screen.getByRole("link", { name: /^Dedupe/ }),
  });
  expect(await screen.findByRole("menuitem", { name: /^Unpin/ })).toBeTruthy();
});

test("the quick Snooze control opens presets without navigation and can wake the thread", async () => {
  await openHome();
  const heading = screen.getByRole("heading", { level: 1 });
  const before = heading.textContent;
  await userEvent.click(await screen.findByRole("button", { name: `Snooze ${title}` }));
  await userEvent.click(await screen.findByRole("menuitem", { name: /^Tomorrow/ }));
  await waitFor(() =>
    expect(screen.getByRole("link", { name: /^Dedupe.*Snoozed until tomorrow/ })).toBeTruthy(),
  );
  expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(before);
  await userEvent.click(screen.getByRole("button", { name: `Snooze ${title}` }));
  await userEvent.click(await screen.findByRole("menuitem", { name: "Wake now" }));
  await waitFor(() =>
    expect(screen.getByRole("link", { name: /^Dedupe/ }).getAttribute("aria-label")).not.toContain(
      "Snoozed",
    ),
  );
});

test("Snooze has one tooltip that dismisses while its menu is open", async () => {
  await openHome();
  const trigger = await screen.findByRole("button", { name: `Snooze ${title}` });
  await userEvent.hover(trigger);
  await screen.findByRole("tooltip", { name: "Snooze…" });
  expect(trigger.hasAttribute("title")).toBe(false);
  await userEvent.click(trigger);
  await screen.findByRole("menuitem", { name: /^Tomorrow/ });
  await waitFor(() => expect(screen.queryByRole("tooltip", { name: "Snooze…" })).toBeNull());
  await userEvent.keyboard("{Escape}");
  await waitFor(() => expect(document.activeElement).toBe(trigger));
});
