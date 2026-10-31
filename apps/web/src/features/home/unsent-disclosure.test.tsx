import { workbench } from "@ace/fake-daemon";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

/**
 * Adding Unsent work must not move the Threads panel (issue #848): it stays on the tree, with
 * each project's settled threads and Snoozed folded away, while a new draft is typed and sent.
 */
async function openWorkbench() {
  const app = harness();
  for (const scenario of workbench()) app.play(scenario).runUntilBlocked();
  await app.open("/new?project=relay");
  const nav = within(await screen.findByRole("navigation", { name: "Threads" }));
  await nav.findByRole("link", { name: /Partial refunds/ });
  return { app, nav };
}

/** The panel shows its tree, with ace's settled threads still folded. */
const onActive = () => {
  expect(document.querySelector('[data-slot="panel-top"] h2')?.textContent).toBe("Threads");
  expect(
    screen.getByRole("button", { name: "1 settled in ace" }).getAttribute("aria-expanded"),
  ).toBe("false");
};

test("typing a draft keeps the panel on its tree with settled threads out of the list", async () => {
  const { nav } = await openWorkbench();
  onActive();
  await userEvent.type(
    await screen.findByRole("combobox", { name: "Message" }),
    "Unsent keeps place",
  );
  await screen.findByRole("link", { name: /Unsent keeps place.*Draft/ });
  onActive();
  expect(nav.queryByRole("link", { name: /^Bump Codex/ })).toBeNull();
});

test("sending a draft keeps the panel on its tree with settled threads out of the list", async () => {
  const { nav } = await openWorkbench();
  await userEvent.type(
    await screen.findByRole("combobox", { name: "Message" }),
    "Send keeps place",
  );
  await screen.findByRole("link", { name: /Send keeps place.*Draft/ });
  await userEvent.type(await screen.findByRole("combobox", { name: "Message" }), "{Enter}");
  await screen.findByRole("heading", { level: 1, name: "Send keeps place" });
  onActive();
  expect(nav.queryByRole("link", { name: /^Bump Codex/ })).toBeNull();
});
