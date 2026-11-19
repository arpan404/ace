import type { SkillSeed } from "@ace/fake-daemon";
import { act, configure, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";
import { useScrollLayout } from "@/test/scroll-layout.ts";
import { openPanelSearch } from "@/test/panel-search.ts";

configure({ asyncUtilTimeout: 10000 });
afterEach(() => localStorage.clear());
await import("./skill-page.tsx");
useScrollLayout({ viewport: 400, row: 37 });

// The most a skills list carries on the wire.
const total = 1_024;
const pad = (n: number) => String(n).padStart(4, "0");
const seeds: SkillSeed[] = Array.from({ length: total }, (_, n) => ({
  name: `skill-${pad(n + 1)}`,
  description: `Skill number ${n + 1}.`,
  body: `# Skill ${pad(n + 1)}\n\nUse it.\n`,
  scope: "personal",
}));

async function open() {
  const app = harness();
  app.daemon.skills.seed(seeds);
  await app.open("/skills");
  const catalog = await screen.findByRole("navigation", { name: "Skills catalog" });
  await within(catalog).findByRole("link", { name: /^Skill 0001/ });
  return within(catalog);
}

test("a library of 1,024 skills mounts only a window of rows", async () => {
  const catalog = await open();
  const links = catalog.getAllByRole("link");
  expect(links.length).toBeGreaterThan(5);
  expect(links.length).toBeLessThan(60);
  expect(catalog.queryByRole("link", { name: /^Skill 1024/ })).toBeNull();
  // The list still names itself and its rows for assistive tech.
  expect(catalog.getByRole("list", { name: "Skills" })).toBeTruthy();
  expect(catalog.getAllByRole("listitem").length).toBe(links.length + 1);
});

test("End reaches the last skill, scrolled into view, and ↑ steps back from it", async () => {
  const catalog = await open();
  const first = catalog.getByRole("link", { name: /^Skill 0001/ });
  act(() => first.focus());
  fireEvent.keyDown(first, { key: "End" });
  await waitFor(() =>
    expect(document.activeElement).toBe(catalog.getByRole("link", { name: /^Skill 1024/ })),
  );
  expect(catalog.queryByRole("link", { name: /^Skill 0001/ })).toBeNull();
  fireEvent.keyDown(document.activeElement ?? document.body, { key: "ArrowUp" });
  await waitFor(() =>
    expect(document.activeElement).toBe(catalog.getByRole("link", { name: /^Skill 1023/ })),
  );
  fireEvent.keyDown(document.activeElement ?? document.body, { key: "Home" });
  await waitFor(() =>
    expect(document.activeElement).toBe(catalog.getByRole("link", { name: /^Skill 0001/ })),
  );
});

test("searching a long library finds a skill far down it", async () => {
  const catalog = await open();
  await userEvent.type(await openPanelSearch("Search skills"), "skill-0777");
  expect(await catalog.findByRole("link", { name: /^Skill 0777/ })).toBeTruthy();
  expect(catalog.getAllByRole("link")).toHaveLength(1);
});

test("folding a home's label away hides its 1,024 skills, and opening it shows them again", async () => {
  const catalog = await open();
  const label = catalog.getByRole("button", { name: /^Personal/ });
  await userEvent.click(label);
  await waitFor(() => expect(catalog.queryAllByRole("link")).toHaveLength(0));
  expect(label.getAttribute("aria-expanded")).toBe("false");
  await userEvent.click(label);
  expect(await catalog.findByRole("link", { name: /^Skill 0001/ })).toBeTruthy();
});
