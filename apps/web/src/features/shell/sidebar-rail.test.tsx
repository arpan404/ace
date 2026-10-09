import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { harness, memoryKeyValue } from "@/test/harness.tsx";

test("the standard rail toggles offcanvas while the header remains the keyboard control", async () => {
  const storage = memoryKeyValue();
  const view = await harness({ storage }).open("/new");
  await screen.findByRole("heading", { level: 1, name: "New thread" });
  const rail = screen.getByRole("button", { name: "Toggle Sidebar" });
  expect(rail.tabIndex).toBe(-1);
  await userEvent.click(rail);
  expect(screen.queryByRole("navigation", { name: "App" })).toBeNull();
  const trigger = screen.getByRole("button", { name: "Show sidebar" });
  trigger.focus();
  await userEvent.keyboard("{Enter}");
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "Hide sidebar" }));
  expect(await screen.findByRole("navigation", { name: "App" })).toBeTruthy();
  await userEvent.click(rail);
  view.unmount();
  await harness({ storage }).open("/new");
  await screen.findByRole("heading", { level: 1, name: "New thread" });
  expect(screen.queryByRole("navigation", { name: "App" })).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "Toggle Sidebar" }));
  expect(await screen.findByRole("navigation", { name: "App" })).toBeTruthy();
});
