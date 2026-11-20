import type { FakeSpadeApi } from "@ace/fake-daemon";
import { configure, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";
import { botRow, openProfile, spadeApp, withEndpoint } from "@/test/spade.ts";

/* A bot's accent (ADR 0200 §5.3): its face ring, its row's marker and its card's title rule. */

configure({ asyncUtilTimeout: 10_000 });
beforeEach(() => localStorage.clear());

function crew(spade: FakeSpadeApi) {
  withEndpoint(spade);
  spade.addAgent({ id: "main", kind: "main", name: "Spade", avatar: { kind: "spade" } });
  const watcher = spade.addAgent({
    id: "watcher",
    name: "Flight watcher",
    style: { accent: "#2f7bea", chosen: false },
  });
  spade.showCard(watcher, "card_1", 1, { title: "Fare dropped", blocks: [] });
  spade.addAgent({ id: "fern", name: "Fern" });
}

const accentOf = (element: Element | null | undefined) =>
  element
    ?.closest<HTMLElement>("[style*='--agent-accent-light']")
    ?.style.getPropertyValue("--agent-accent-light");

test("a bot's package accent marks its list row, its profile face and its card's rule; a bot without one marks nothing", async () => {
  await spadeApp("/spade/watcher", crew);
  const row = await botRow("Flight watcher");
  const marker = row.querySelector("[data-agent-accent='row']");
  expect(accentOf(marker)).toBe("#2f7bea");
  expect((await botRow("Fern")).querySelector("[data-agent-accent]")).toBeNull();
  expect((await botRow("Spade")).querySelector("[data-agent-accent]")).toBeNull();

  const card = await screen.findByRole("region", { name: "Flight watcher: Fare dropped" });
  expect(accentOf(card.querySelector("[data-agent-accent]"))).toBe("#2f7bea");

  await openProfile("Flight watcher");
  const ring = await waitFor(() => {
    const found = document.querySelector("[data-agent-accent='ring']");
    if (!found) throw new Error("no ring yet");
    return found;
  });
  expect(accentOf(ring)).toBe("#2f7bea");
});

test("choosing an accent in the profile saves it and every mark follows; its face's colour removes the marks", async () => {
  const { spade } = await spadeApp("/spade/fern", crew);
  expect((await botRow("Fern")).querySelector("[data-agent-accent]")).toBeNull();
  await openProfile("Fern");
  const choices = await screen.findByRole("radiogroup", { name: "Accent" });
  const names = within(choices)
    .getAllByRole("radio")
    .map((radio) => radio.getAttribute("aria-label"));
  expect(names).toEqual([
    "Its face's colour",
    "Blue",
    "Teal",
    "Green",
    "Orange",
    "Magenta",
    "Violet",
  ]);
  expect(
    within(choices).getByRole("radio", { name: "Its face's colour" }).getAttribute("aria-checked"),
  ).toBe("true");

  await userEvent.click(within(choices).getByRole("radio", { name: "Violet" }));
  await waitFor(() =>
    expect(accentOf(document.querySelector("[data-agent-accent='ring']"))).toBe("#8b5cf6"),
  );
  expect(spade.agents.find((agent) => agent.id === "fern")?.style).toEqual({
    accent: "#8b5cf6",
    chosen: true,
  });
  expect(accentOf((await botRow("Fern")).querySelector("[data-agent-accent='row']"))).toBe(
    "#8b5cf6",
  );

  await userEvent.click(within(choices).getByRole("radio", { name: "Its face's colour" }));
  await waitFor(() => expect(document.querySelector("[data-agent-accent='ring']")).toBeNull());
  expect((await botRow("Fern")).querySelector("[data-agent-accent]")).toBeNull();
});

test("Spade's own profile has no accent to choose", async () => {
  await spadeApp("/spade/main", crew);
  await openProfile("Spade");
  await screen.findByRole("heading", { name: "Personality" });
  expect(screen.queryByRole("radiogroup", { name: "Accent" })).toBeNull();
});
