import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

/** The top bar's own heading, not the panel's. */
async function barTitle(name: string) {
  const bar = await waitFor(() => {
    const header = document.querySelector<HTMLElement>('[data-slot="app-header"]');
    if (!header) throw new Error("no top bar yet");
    return header;
  });
  return within(bar).findByRole("heading", { level: 1, name });
}

test("a page its panel already names keeps its top-bar title for screen readers only until the sidebar hides", async () => {
  await harness().open("/skills");
  const title = await barTitle("Skills");
  expect(title.className).toContain("sr-only");
  // With nothing beside it, the bar draws no marker where the sidebar meets the column.
  expect(document.querySelector('[data-boundary="sidebar"]')).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "Hide sidebar" }));
  await waitFor(async () => expect((await barTitle("Skills")).className).not.toContain("sr-only"));
});

test("a page the panel doesn't name keeps its top-bar title in view", async () => {
  await harness().open("/new");
  expect((await barTitle("New thread")).className).not.toContain("sr-only");
  expect(document.querySelector('[data-boundary="sidebar"]')).not.toBeNull();
});
