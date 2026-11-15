import { workbench, workbenchServices } from "@ace/fake-daemon";
import { configure, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

/*
 * Skills' and Automations' pages name their parts for Suits (ADR 0150,
 * docs/design/suit-parts.md): the page's header, title and body, the catalog's groups, a
 * plugin's contents, and each run of an automation with how it went.
 */

configure({ asyncUtilTimeout: 10_000 });
beforeEach(() => localStorage.clear());

/** The parts this screen is missing from `parts`. */
function missing(parts: readonly string[]): string[] {
  const shown = new Set(
    [...document.querySelectorAll("[data-part]")].map((element) =>
      element.getAttribute("data-part"),
    ),
  );
  return parts.filter((part) => !shown.has(part));
}

/** The design's daemon: its threads, plugins and automations. */
async function open(path: string) {
  const app = harness({ clock: () => Date.now() });
  for (const scenario of workbench()) app.play(scenario).runUntilBlocked();
  app.daemon.seedServices(workbenchServices(Date.now(), "UTC"));
  app.daemon.skills.seed([]);
  await app.open(path);
  return app;
}

test("a plugin's page names its header, title and body, and groups what it ships", async () => {
  await open("/skills/plugin~engineering");
  const title = await screen.findByRole("heading", { level: 2, name: "Engineering" });
  expect(title.getAttribute("data-part")).toBe("page-title");
  const contents = within(screen.getByRole("region", { name: "Contents" }));
  const skills = contents.getByRole("list", { name: "Skills" });
  expect(skills.getAttribute("data-part")).toBe("list-group");
  expect(skills.getAttribute("data-variant")).toBe("skill");
  expect(missing(["page-header", "page-body"])).toEqual([]);
});

test("the skills catalog is a list whose homes are its groups", async () => {
  await open("/skills");
  await screen.findByRole("heading", { level: 2, name: "Code review" });
  const catalog = screen.getByRole("navigation", { name: "Skills catalog" });
  expect(catalog.getAttribute("data-part")).toBe("list");
  await waitFor(() =>
    expect(catalog.querySelectorAll("[data-part=list-group]").length).toBeGreaterThan(0),
  );
  expect(missing(["page-title", "page-body"])).toEqual([]);
});

test("an automation's runs are list rows whose state follows how each run went", async () => {
  await open("/automations/auto-dependency-audit");
  const runs = await screen.findAllByRole("article", { name: /^Run, / });
  expect(runs.map((run) => run.getAttribute("data-part"))).toEqual(runs.map(() => "list-row"));
  // Oldest first: the failed run, then the ones that finished.
  expect(runs[0]?.getAttribute("data-state")).toBe("failed");
  expect(runs.at(-1)?.getAttribute("data-state")).toBe("done");
  expect(screen.getByRole("region", { name: "Runs" }).getAttribute("data-part")).toBe("list");
  expect(missing(["page-header", "page-title", "page-body", "card"])).toEqual([]);
});

test("a new automation's ideas are a section of list rows", async () => {
  await open("/automations/new");
  const ideas = await screen.findByRole("region", { name: "Ideas" });
  expect(ideas.getAttribute("data-part")).toBe("page-section");
  const rows = within(ideas).getAllByRole("button");
  expect(rows.length).toBeGreaterThan(0);
  expect(rows.every((row) => row.getAttribute("data-part") === "list-row")).toBe(true);
  expect(missing(["page-title", "list"])).toEqual([]);
});
