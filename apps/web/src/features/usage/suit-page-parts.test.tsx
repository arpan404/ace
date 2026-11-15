import { workbench } from "@ace/fake-daemon";
import { ThreadId } from "@ace/protocol";
import { configure, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test, vi } from "vitest";
import { openSearchSheet } from "@/test/open-search.ts";
import { harness, memoryKeyValue } from "@/test/harness.tsx";

/*
 * The Suit styling contract (ADR 0150, docs/design/suit-parts.md) on full pages: Usage, History
 * and the search sheet draw the page parts a `suit.css` selects, with their states.
 */

configure({ asyncUtilTimeout: 10_000 });
vi.setConfig({ testTimeout: 30_000 });
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

test("Usage draws its header, sections, figures, limit bars and ledger as page parts", async () => {
  const app = harness();
  const account = app.daemon.services.accounts.find((entry) => entry.id === "codex-personal");
  if (!account) throw new Error("no codex-personal account");
  account.quota.windows = { five_hour: { usedPercent: 40, resetsAt: Date.now() + 3_600_000 } };
  app.daemon.services.usage.sources = [
    {
      provider: "codex",
      account: "codex-personal",
      model: "gpt-5.3-codex",
      daily: 80_000,
      steady: true,
      apiUsdPerMillion: 5,
      billing: "subscription",
      threads: ["thread-codex"],
    },
  ];
  await app.open("/usage");
  await screen.findByRole("list", { name: /^Spend by / });
  await waitFor(() =>
    expect(
      missing([
        "page-body",
        "page-header",
        "page-title",
        "page-toolbar",
        "page-section",
        "stat",
        "chart",
        "filter-bar",
        "list",
        "list-group",
        "list-row",
      ]),
    ).toEqual([]),
  );
  expect(screen.getByTestId("usage-total").getAttribute("data-part")).toBe("stat");
  const limits = await screen.findByRole("article", { name: /^Codex · Personal · / });
  expect(
    within(limits).getByRole("meter", { name: "Session (5h)" }).getAttribute("data-part"),
  ).toBe("chart");
  // A ledger row that opens says so.
  const row = within(await screen.findByRole("list", { name: /^Spend by / })).getAllByRole(
    "button",
  )[0];
  if (!row) throw new Error("no ledger row");
  await userEvent.click(row);
  expect(row.closest("[data-part=list-row]")?.getAttribute("data-state")).toBe("open");
});

test("History marks its settled list, its rows and the chosen project chip", async () => {
  const storage = memoryKeyValue();
  storage.setItem("ace.home.organizer", JSON.stringify({ baseline: 0, project: null }));
  const app = harness({ storage });
  const scenario = workbench().find((entry) => entry.thread.id === "thread-bump-codex");
  if (!scenario) throw new Error("Missing done scenario");
  await app.client.start();
  app.play(scenario).runUntilBlocked();
  await app.client.command({ type: "thread.settle", threadId: ThreadId.parse(scenario.thread.id) });
  await app.open("/history");
  const main = await screen.findByRole("main");
  await within(main).findByRole("link", { name: /^Bump Codex/ });
  await waitFor(() =>
    expect(
      missing(["page-body", "page-title", "filter-bar", "label-chip", "list", "list-row"]),
    ).toEqual([]),
  );
  const chip = (name: string) => within(main).getByRole("button", { name });
  expect(chip("All projects").getAttribute("data-state")).toBe("selected");
});

test("the search sheet marks its results and the highlighted one as selected", async () => {
  const app = harness();
  await app.open("/new");
  await screen.findByRole("heading", { level: 1, name: "New thread" });
  const field = await openSearchSheet();
  await userEvent.type(field, "retry budget");
  const results = await screen.findByRole("listbox", { name: "Results" });
  expect(results.getAttribute("data-part")).toBe("list");
  const selected = () =>
    within(results)
      .getAllByRole("option")
      .map((option) => option.getAttribute("data-state"));
  await waitFor(() => expect(selected()).toEqual(["selected", null]));
  await userEvent.keyboard("{ArrowDown}");
  expect(selected()).toEqual([null, "selected"]);
});
