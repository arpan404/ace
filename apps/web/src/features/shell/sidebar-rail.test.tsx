import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { harness, memoryKeyValue } from "@/test/harness.tsx";

test("a hidden sidebar's rail brings it back while the sidebar toggle remains the keyboard control", async () => {
  const storage = memoryKeyValue();
  const view = await harness({ storage }).open("/new");
  await screen.findByRole("heading", { level: 1, name: "New thread" });
  // Shown, the sidebar's edge resizes it instead of toggling it.
  expect(screen.queryByRole("button", { name: "Toggle Sidebar" })).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "Hide sidebar" }));
  expect(screen.queryByRole("navigation", { name: "App" })).toBeNull();
  const rail = screen.getByRole("button", { name: "Toggle Sidebar" });
  expect(rail.tabIndex).toBe(-1);
  const trigger = screen.getByRole("button", { name: "Show sidebar" });
  trigger.focus();
  await userEvent.keyboard("{Enter}");
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "Hide sidebar" }));
  expect(await screen.findByRole("navigation", { name: "App" })).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "Hide sidebar" }));
  view.unmount();
  await harness({ storage }).open("/new");
  await screen.findByRole("heading", { level: 1, name: "New thread" });
  expect(screen.queryByRole("navigation", { name: "App" })).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "Toggle Sidebar" }));
  expect(await screen.findByRole("navigation", { name: "App" })).toBeTruthy();
});
