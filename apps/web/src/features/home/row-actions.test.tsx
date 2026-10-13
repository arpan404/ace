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

async function openActions(name: string) {
  await userEvent.click(await screen.findByRole("button", { name: `Actions for ${name}` }));
  await screen.findByRole("menuitem", { name: /^Rename/ });
}

test("hover menu shortcuts rename, pin and archive its row while another thread is open", async () => {
  const app = harness();
  app.daemon.services.settings.seed({ "clients.keybindings": { archiveThread: "alt+mod+y" } });
  for (const scenario of workbench()) app.play(scenario).runUntilBlocked();
  await app.open("/t/thread-docs-index");
  const activeTitle = await screen.findByRole("heading", { level: 1 });
  const before = activeTitle.textContent;

  await openActions(title);
  await userEvent.keyboard("{Alt>}{Meta>}r{/Meta}{/Alt}");
  const field = await screen.findByRole("textbox", { name: "Thread title" });
  expect(activeTitle.textContent).toBe(before);
  await userEvent.clear(field);
  await userEvent.type(field, "Renamed row{Enter}");
  const threads = screen.getByRole("navigation", { name: "Threads" });
  await within(threads).findByRole("link", { name: /^Renamed row/ });

  await openActions("Renamed row");
  await userEvent.keyboard("{Alt>}{Meta>}p{/Meta}{/Alt}");
  await waitFor(() =>
    expect(within(threads).getByRole("link", { name: /^Renamed row.*Pinned/ })).toBeTruthy(),
  );
  expect(activeTitle.textContent).toBe(before);
  await openActions("Renamed row");
  await userEvent.keyboard("{Alt>}{Meta>}y{/Meta}{/Alt}");
  await userEvent.click(await screen.findByRole("button", { name: "Archive, keep running" }));
  await waitFor(() =>
    expect(within(threads).queryByRole("link", { name: /^Renamed row/ })).toBeNull(),
  );
  expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(before);
});

test("the row overflow opens Snooze presets without navigation and can wake the thread", async () => {
  await openHome();
  const heading = screen.getByRole("heading", { level: 1 });
  const before = heading.textContent;
  await userEvent.click(await screen.findByRole("button", { name: `Actions for ${title}` }));
  await userEvent.hover(await screen.findByRole("menuitem", { name: /^Snooze/ }));
  await userEvent.click(await screen.findByRole("menuitem", { name: /^Tomorrow/ }));
  await userEvent.click(await screen.findByRole("button", { name: "Snoozed (1)" }));
  expect(screen.getByRole("link", { name: /^Dedupe.*Snoozed until tomorrow/ })).toBeTruthy();
  expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(before);
  await userEvent.click(screen.getByRole("button", { name: `Actions for ${title}` }));
  await userEvent.hover(await screen.findByRole("menuitem", { name: /^Snooze/ }));
  await userEvent.click(await screen.findByRole("menuitem", { name: "Wake now" }));
  await waitFor(() =>
    expect(screen.getByRole("link", { name: /^Dedupe/ }).getAttribute("aria-label")).not.toContain(
      "Snoozed",
    ),
  );
});

test("the row overflow tooltip dismisses while its menu is open and Escape restores focus", async () => {
  await openHome();
  const label = `Actions for ${title}`;
  const trigger = await screen.findByRole("button", { name: label });
  await userEvent.hover(trigger);
  await screen.findByRole("tooltip", { name: label });
  expect(trigger.hasAttribute("title")).toBe(false);
  await userEvent.click(trigger);
  await screen.findByRole("menuitem", { name: /^Snooze/ });
  await waitFor(() => expect(screen.queryByRole("tooltip", { name: label })).toBeNull());
  await userEvent.keyboard("{Escape}");
  await waitFor(() => expect(document.activeElement).toBe(trigger));
});
