import { expect, test } from "vitest";
import {
  workCardColumnWidth,
  workCardFitsSide,
  workCardMinColumn,
  workCardReserve,
  workCardWidth,
} from "./work-card-store.ts";

const column = 760;

test("a wide area keeps the full reading column beside the card", () => {
  expect(workCardFitsSide(1800, column)).toBe(true);
  expect(workCardColumnWidth(1800, column)).toBe(column);
});

test("a full column with the card needs column plus card plus gaps", () => {
  expect(workCardFitsSide(column + workCardWidth + 48, column)).toBe(true);
  expect(workCardFitsSide(column + workCardWidth + 47, column)).toBe(true);
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

test("the docked reserve holds the card with its edge and gap", () => {
  expect(workCardReserve).toBe(workCardWidth + 24);
});
