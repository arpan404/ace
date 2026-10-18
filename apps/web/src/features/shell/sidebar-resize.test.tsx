import { fireEvent, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { harness, memoryKeyValue } from "@/test/harness.tsx";

const handle = () => screen.getByRole("separator", { name: "Resize sidebar" });
const width = () => Number(handle().getAttribute("aria-valuenow"));

async function openNew(storage = memoryKeyValue()) {
  const view = await harness({ storage }).open("/new");
  await screen.findByRole("heading", { level: 1, name: "New thread" });
  return { view, storage };
}

test("dragging the sidebar's edge widens it, and the width is kept across a reload", async () => {
  const { view, storage } = await openNew();
  expect(width()).toBe(336);
  fireEvent.pointerDown(handle(), { button: 0, pointerId: 1, clientX: 336 });
  fireEvent.pointerMove(handle(), { pointerId: 1, clientX: 400 });
  expect(width()).toBe(400);
  fireEvent.pointerUp(handle(), { pointerId: 1, clientX: 400 });
  view.unmount();

  await openNew(storage);
  expect(width()).toBe(400);
});

test("the sidebar's width stays within its bounds and a double-click puts it back", async () => {
  await openNew();
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
  await openNew();
  handle().focus();
  await userEvent.keyboard("{ArrowRight}");
  expect(width()).toBe(352);
  await userEvent.keyboard("{Shift>}{ArrowLeft}{/Shift}");
  expect(width()).toBe(288);
});
