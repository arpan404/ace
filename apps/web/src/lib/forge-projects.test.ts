import { expect, test } from "vitest";
import { pickedProjects, projectsLabel, toggleProject } from "./forge-projects.ts";

const all = ["ace", "billing", "docs"];
const name = (id: string) => ({ ace: "ace", billing: "billing-api", docs: "docs-site" })[id] ?? id;

test("the address's pick wins over the remembered one; an older one-project link still works", () => {
  expect(pickedProjects({}, [], all)).toEqual([]);
  expect(pickedProjects({}, ["docs"], all)).toEqual(["docs"]);
  expect(pickedProjects({ projects: ["ace"] }, ["docs"], all)).toEqual(["ace"]);
  expect(pickedProjects({ projects: [] }, ["docs"], all)).toEqual([]);
  expect(pickedProjects({ project: "billing" }, [], all)).toEqual(["billing"]);
});

test("a pick keeps only projects that still exist, and naming all of them is every project", () => {
  expect(pickedProjects({ projects: ["gone"] }, [], all)).toEqual([]);
  expect(pickedProjects({ projects: ["docs", "gone", "ace"] }, [], all)).toEqual(["ace", "docs"]);
  expect(pickedProjects({ projects: [...all] }, [], all)).toEqual([]);
});

test("ticking adds a project and unticking removes it; the last untick or the last tick is every project", () => {
  expect(toggleProject([], "docs", all)).toEqual(["docs"]);
  expect(toggleProject(["docs"], "ace", all)).toEqual(["ace", "docs"]);
  expect(toggleProject(["ace", "docs"], "ace", all)).toEqual(["docs"]);
  expect(toggleProject(["docs"], "docs", all)).toEqual([]);
  expect(toggleProject(["ace", "docs"], "billing", all)).toEqual([]);
});

test("the menu reads All projects, one name, two names, then a count", () => {
  expect(projectsLabel([], name)).toBe("All projects");
  expect(projectsLabel(["docs"], name)).toBe("docs-site");
  expect(projectsLabel(["ace", "docs"], name)).toBe("ace, docs-site");
  expect(projectsLabel(all, name)).toBe("3 projects");
});
