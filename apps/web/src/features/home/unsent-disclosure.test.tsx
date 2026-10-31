import { workbench } from "@ace/fake-daemon";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

/**
 * Adding Unsent work must not move the Threads panel (issue #848): it stays on its project tree,
 * with the long-settled Codex bump left to History, while a new draft is typed and sent.
 */
async function openWorkbench() {
  const app = harness();
  for (const scenario of workbench()) app.play(scenario).runUntilBlocked();
  await app.open("/new?project=relay");
  const nav = within(await screen.findByRole("navigation", { name: "Threads" }));
  await nav.findByRole("link", { name: /^Dedupe thread events/ });
  return { app, nav };
}

/** The panel shows its project tree: ace open on its running thread. */
const onActive = () => {
  expect(screen.getByRole("button", { name: /^Project filter/ }).textContent).toBe("ace");
  const nav = within(screen.getByRole("navigation", { name: "Threads" }));
  expect(nav.getByRole("button", { name: /^ace, 1 running/ }).getAttribute("aria-expanded")).toBe(
    "true",
  );
  expect(nav.getByRole("link", { name: /^Dedupe thread events/ })).toBeTruthy();
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
