import { fireEvent, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { harness, memoryKeyValue } from "@/test/harness.tsx";

const handle = () => screen.getByRole("separator", { name: "Resize sidebar" });
const width = () => Number(handle().getAttribute("aria-valuenow"));

/**
 * Settings, where nothing takes focus on its own: New thread with no project is a chat whose
 * composer would take the keys meant for the handle.
 */
async function openSettings(storage = memoryKeyValue()) {
  const view = await harness({ storage }).open("/settings");
  await screen.findByRole("heading", { level: 1, name: "Settings" });
  return { view, storage };
}

test("dragging the sidebar's edge widens it, and the width is kept across a reload", async () => {
  const { view, storage } = await openSettings();
  expect(width()).toBe(336);
  fireEvent.pointerDown(handle(), { button: 0, pointerId: 1, clientX: 336 });
  fireEvent.pointerMove(handle(), { pointerId: 1, clientX: 400 });
  expect(width()).toBe(400);
  fireEvent.pointerUp(handle(), { pointerId: 1, clientX: 400 });
  view.unmount();

  await openSettings(storage);
  expect(width()).toBe(400);
});

test("the sidebar's width stays within its bounds and a double-click puts it back", async () => {
  await openSettings();
  handle().focus();
  await userEvent.keyboard("{End}");
  expect(width()).toBe(480);
  await userEvent.keyboard("{ArrowRight}");
  expect(width()).toBe(480);
  await userEvent.keyboard("{Home}");
  expect(width()).toBe(220);
  await userEvent.dblClick(handle());
  expect(width()).toBe(336);
});

test("arrow keys on the sidebar's edge grow it to the right and shrink it to the left", async () => {
  await openSettings();
  handle().focus();
  await userEvent.keyboard("{ArrowRight}");
  expect(width()).toBe(352);
  await userEvent.keyboard("{Shift>}{ArrowLeft}{/Shift}");
  expect(width()).toBe(288);
});
