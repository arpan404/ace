import { expect, test } from "vitest";
import { historySections } from "./home-history.ts";

test("History groups settled threads by week, newest first, and filters by project", () => {
  const day = 24 * 60 * 60 * 1000;
  const now = new Date(2026, 9, 31, 15).getTime();
  const items = [
    { id: "old", at: now - 20 * day, project: "ace" },
    { id: "new", at: now - day, project: "ace" },
    { id: "web", at: now - 2 * day, project: "web" },
    { id: "last", at: now - 9 * day, project: "ace" },
    // A loaded thread and the daemon's hit for it are one row.
    { id: "new", at: now - day, project: "ace" },
  ];
  const all = historySections(items, { project: null, now });
  expect(all.map((section) => [section.label, section.items.map((item) => item.id)])).toEqual([
    ["This week", ["new", "web"]],
    ["Last week", ["last"]],
    ["Earlier", ["old"]],
  ]);
  const web = historySections(items, { project: "web", now });
  expect(web.map((section) => [section.label, section.items.map((item) => item.id)])).toEqual([
    ["This week", ["web"]],
  ]);
});
