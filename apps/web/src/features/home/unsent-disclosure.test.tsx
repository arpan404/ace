import { workbench } from "@ace/fake-daemon";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

/**
 * Adding Unsent work must not move the Threads panel (issue #848): it stays on its Inbox, filtered
 * nowhere, with the running thread listed and the long-settled Codex bump left to Settled, while a
 * new draft is typed and sent.
 */
async function openWorkbench() {
  const app = harness();
  for (const scenario of workbench()) app.play(scenario).runUntilBlocked();
  await app.open("/new?project=relay");
  const nav = within(await screen.findByRole("navigation", { name: "Threads" }));
  await nav.findByRole("link", { name: /^Dedupe thread events/ });
  return { app, nav };
}

/** The panel shows its Inbox with no filter: Threads and Search on top, All projects below, the running thread listed, the settled one not. */
const onInbox = () => {
  const panel = screen.getByRole("complementary", { name: "Threads" });
  expect(within(panel).getByRole("heading", { level: 2, name: "Threads" })).toBeTruthy();
  expect(within(panel).getByRole("button", { name: "Search" })).toBeTruthy();
  const filter = screen.getByRole("button", { name: /^Project filter/ });
  expect(filter.textContent).toBe("All projects");
  // The filter sits in the row under the title row, beside New thread.
  const titleRow = within(panel)
    .getByRole("button", { name: "Search" })
    .closest('[data-slot="panel-top"]');
  expect(
    within(titleRow as HTMLElement).queryByRole("button", { name: /^Project filter/ }),
  ).toBeNull();
  let row: HTMLElement | null = filter.parentElement;
  while (row && !within(row).queryByRole("link", { name: "New thread" })) row = row.parentElement;
  expect(row).toBeTruthy();
  expect(row).not.toBe(titleRow);
  const nav = within(screen.getByRole("navigation", { name: "Threads" }));
  expect(nav.getByRole("tab", { name: /^Inbox/ }).getAttribute("aria-selected")).toBe("true");
  expect(nav.getByRole("link", { name: /^Dedupe thread events/ })).toBeTruthy();
  expect(nav.queryByRole("link", { name: /^Bump Codex/ })).toBeNull();
};

test("typing a draft keeps the panel on its Inbox", async () => {
  await openWorkbench();
  onInbox();
  await userEvent.type(
    await screen.findByRole("combobox", { name: "Message" }),
    "Unsent keeps place",
  );
  await screen.findByRole("link", { name: /Unsent keeps place.*Draft/ });
  onInbox();
});

test("sending a draft keeps the panel on its Inbox", async () => {
  await openWorkbench();
  await userEvent.type(
    await screen.findByRole("combobox", { name: "Message" }),
    "Send keeps place",
  );
  await screen.findByRole("link", { name: /Send keeps place.*Draft/ });
  await userEvent.type(await screen.findByRole("combobox", { name: "Message" }), "{Enter}");
  await screen.findByRole("heading", { level: 1, name: "Send keeps place" });
  onInbox();
});
