import { expect, test } from "vitest";
import { cityOf, searchZones } from "./zone-search.tsx";

const zones = [
  "America/Argentina/Buenos_Aires",
  "America/New_York",
  "America/Newfoundland",
  "Asia/Kathmandu",
  "Europe/London",
];

test("a zone is found by its city in plain words, cities that start with them first", () => {
  expect(searchZones(zones, "new york")).toEqual(["America/New_York"]);
  expect(searchZones(zones, "york")).toEqual(["America/New_York"]);
  expect(searchZones(zones, "new")).toEqual(["America/New_York", "America/Newfoundland"]);
  expect(searchZones(zones, "america/new")).toEqual(["America/New_York", "America/Newfoundland"]);
  expect(searchZones(zones, "Buenos")).toEqual(["America/Argentina/Buenos_Aires"]);
  expect(searchZones(zones, "moon")).toEqual([]);
  expect(searchZones(zones, "  ")).toEqual(zones);
  expect(cityOf("America/Argentina/Buenos_Aires")).toBe("Buenos Aires");
});
