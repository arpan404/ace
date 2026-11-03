import { expect, test } from "vitest";
import {
  createWorkCardStore,
  workCardColumnWidth,
  workCardFitsSide,
  workCardMinColumn,
  workCardWidth,
} from "./work-card-store.ts";

const column = 760;

test("a wide area keeps the full reading column beside the card", () => {
  expect(workCardFitsSide(1800, column)).toBe(true);
  expect(workCardColumnWidth(1800, column)).toBe(column);
});

test("a mid-width area docks the card beside a narrowed column", () => {
  expect(workCardFitsSide(1000, column)).toBe(true);
  expect(workCardColumnWidth(1000, column)).toBe(1000 - workCardWidth - 48);
});

test("at the minimum the column reads at its narrowest", () => {
  const area = workCardMinColumn + workCardWidth + 48;
  expect(workCardFitsSide(area, column)).toBe(true);
  expect(workCardColumnWidth(area, column)).toBe(workCardMinColumn);
});

test("below the minimum the card leaves the side for the header popover", () => {
  const area = workCardMinColumn + workCardWidth + 48 - 1;
  expect(workCardFitsSide(area, column)).toBe(false);
});

function memory(open: boolean) {
  const saved = { open };
  return { saved, memory: { open, remember: (next: boolean) => void (saved.open = next) } };
}

test("a card left open comes back docked on the next thread screen", () => {
  const first = memory(false);
  const before = createWorkCardStore(first.memory);
  before.setSide(true);
  before.toggle();
  const next = createWorkCardStore(memory(first.saved.open).memory);
  next.setSide(true);
  expect(next.get()).toEqual({ open: true, side: true });
});

test("a card closed on purpose stays closed on the next thread screen", () => {
  const first = memory(true);
  const before = createWorkCardStore(first.memory);
  before.setSide(true);
  before.setOpen(false);
  const next = createWorkCardStore(memory(first.saved.open).memory);
  next.setSide(true);
  expect(next.get().open).toBe(false);
});

test("a remembered card never comes back as the popover in a narrow area", () => {
  const { saved, memory: remembered } = memory(true);
  const store = createWorkCardStore(remembered);
  store.setSide(false);
  expect(store.get().open).toBe(false);
  // The person's choice is kept for a thread screen with room.
  expect(saved.open).toBe(true);
});

test("a docked card squeezed out by a narrow area is still open on the next thread screen", () => {
  const first = memory(false);
  const before = createWorkCardStore(first.memory);
  before.setSide(true);
  before.toggle();
  // The next thread's side panel opens and squeezes the area for a moment.
  before.setSide(false);
  expect(before.get().open).toBe(false);
  const next = createWorkCardStore(memory(first.saved.open).memory);
  next.setSide(true);
  expect(next.get()).toEqual({ open: true, side: true });
});

test("a squeezed-out card docks again once the area has room", () => {
  const store = createWorkCardStore(memory(false).memory);
  store.setSide(true);
  store.toggle();
  store.setSide(false);
  store.setSide(true);
  expect(store.get()).toEqual({ open: true, side: true });
});

test("a remembered card waits for room when the first measure is narrow", () => {
  const store = createWorkCardStore(memory(true).memory);
  store.setSide(false);
  store.setSide(true);
  expect(store.get()).toEqual({ open: true, side: true });
});

test("a card closed while squeezed out stays closed when the room comes back", () => {
  const { saved, memory: remembered } = memory(true);
  const store = createWorkCardStore(remembered);
  store.setSide(false);
  store.toggle();
  store.setOpen(false);
  store.setSide(true);
  expect(store.get().open).toBe(false);
  expect(saved.open).toBe(false);
});
