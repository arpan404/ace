import type { FakeSpadeApi } from "@ace/fake-daemon";
import { configure, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { botRow, openProfile, spadeApp, withEndpoint } from "@/test/spade.ts";

configure({ asyncUtilTimeout: 10_000 });
beforeEach(() => localStorage.clear());
afterEach(() => vi.restoreAllMocks());

const spending = { today_micros: 420_000, month_micros: 3_100_000 };

function seed(spade: FakeSpadeApi) {
  withEndpoint(spade);
  spade.addAgent({ id: "main", kind: "main", name: "Spade", avatar: { kind: "spade" } });
  return spade.addAgent({ id: "scout", name: "Scout", spending: { ...spending } });
}

const at = Date.UTC(2026, 10, 12, 9, 30);
const entry = (seq: number, fields: Record<string, unknown>) => ({
  id: `${seq}-0`,
  seq,
  at: at + seq * 60_000,
  reply: null,
  cost_micros: null,
  ...fields,
});

/** The activity reads Scout's page sent, as query strings. */
const activityReads = (spade: FakeSpadeApi) =>
  spade.requests
    .filter((request) => request.path.startsWith("/v1/agents/scout/activity"))
    .map((request) => request.path.split("?")[1] ?? "");

/** Scout's activity: its profile, on Computer's Activity. */
async function openActivity() {
  await userEvent.click(await botRow("Scout"));
  await openProfile("Scout");
  const profile = within(await screen.findByRole("region", { name: "Scout's profile" }));
  await userEvent.click(profile.getByRole("tab", { name: "Computer" }));
}

/** Scout's profile, on Details, and its Spending section. */
async function spendingOf() {
  await userEvent.click(await botRow("Scout"));
  await openProfile("Scout");
  const profile = within(await screen.findByRole("region", { name: "Scout's profile" }));
  await userEvent.click(profile.getByRole("tab", { name: "Details" }));
  const section = (await profile.findByRole("heading", { name: "Spending" })).closest("section");
  if (!section) throw new Error("no Spending section");
  return within(section);
}

test("a bot's activity says what it did in Spade's words, newest first, marking only what went wrong", async () => {
  await spadeApp("/spade", (api) => {
    seed(api);
    api.oversight.activity.set("scout", [
      entry(3, {
        kind: "tool",
        name: "web_fetch",
        summary: "url: https://example.com/fares",
        sentence: "Read a web page",
        detail: "https://example.com/fares",
        outcome: "error",
      }),
      entry(2, {
        kind: "spend",
        name: null,
        summary: "3 steps",
        outcome: "finished",
        cost_micros: 23_000,
      }),
      entry(1, {
        kind: "tool",
        name: "web_search",
        summary: "query: flights to Lisbon",
        sentence: "Searched the web",
        detail: "flights to Lisbon",
        outcome: "ok",
      }),
    ]);
  });
  await openActivity();
  const list = within(await screen.findByRole("list", { name: "Activity" }));
  const rows = () => list.getAllByRole("listitem").map((row) => row.textContent ?? "");
  await waitFor(() => expect(rows()).toHaveLength(3));
  expect(rows()[0]).toMatch(/^Read a web pageFailedhttps:\/\/example\.com\/fares$/);
  expect(rows()[1]).toMatch(/^Finished a turn.+3 steps$/);
  expect(rows()[2]).toMatch(/^Searched the web.+flights to Lisbon$/);
  // A step that went fine says nothing more, and no tool's name or arguments show.
  expect(rows().join()).not.toMatch(/Done|web_search|query:/);
  // Nothing of this is in the chat beside it.
  expect(within(screen.getByRole("feed")).queryByText("Searched the web")).toBeNull();
});

test("Show older reads the page before the last entry shown", async () => {
  const { spade } = await spadeApp("/spade", (api) => {
    seed(api);
    api.oversight.activity.set(
      "scout",
      Array.from({ length: 51 }, (_, index) =>
        entry(51 - index, { kind: "routine", name: `Run ${51 - index}`, summary: "9:00" }),
      ),
    );
  });
  await openActivity();
  await userEvent.click(await screen.findByRole("button", { name: "Show older" }));
  await waitFor(() => expect(activityReads(spade)).toContain("before=2&limit=50"));
  await waitFor(() =>
    expect(
      within(screen.getByRole("list", { name: "Activity" })).getAllByRole("listitem"),
    ).toHaveLength(51),
  );
  expect(screen.queryByRole("button", { name: "Show older" })).toBeNull();
});

test("the profile shows what a bot spent, with no spending limit to set", async () => {
  const { spade } = await spadeApp("/spade", seed);
  const section = await spendingOf();
  expect(section.getByText("$3.10")).toBeTruthy();
  expect(section.getByText("$0.42 today")).toBeTruthy();
  // Spade has no spending limits (ADR 0166): nothing to type, raise or save.
  expect(section.queryAllByRole("textbox")).toHaveLength(0);
  expect(section.queryByText(/cap|limit|budget/i)).toBeNull();
  expect(spade.sent("PUT", "/v1/agents/scout/oversight")).toEqual([]);
});

test("a cap an older Spade sent or stored never shows, on the row or in the chat", async () => {
  await spadeApp("/spade", (api) => {
    const scout = seed(api);
    const older = { ...spending, daily_cap_micros: 1_000_000, capped: "daily", resets_at: at };
    scout.spending = older;
    api.store(scout.conversation, {
      type: "cap_reached",
      scope: "daily",
      cap_micros: 1_000_000,
      period_start: at,
    });
    api.reply(scout, "Still on it.");
  });
  expect((await botRow("Scout")).textContent).not.toMatch(/cap/i);
  await userEvent.click(await botRow("Scout"));
  const chat = within(await screen.findByRole("feed", { name: "Conversation with Scout" }));
  expect(await chat.findByText("Still on it.")).toBeTruthy();
  expect(chat.queryByText(/spending cap/i)).toBeNull();
});

test("a report's chip on the bot's bubble opens the report in its files", async () => {
  await spadeApp("/spade", (api) => {
    const scout = seed(api);
    api.files.set("scout", { "research/2026-11-12-fares.md": "# Fares\n\nLisbon is cheapest." });
    api.store(scout.conversation, {
      type: "job_finished",
      job: "k1",
      name: "research",
      files: ["research/2026-11-12-fares.md"],
    });
    api.reply(scout, "The report is ready.");
  });
  await userEvent.click(await botRow("Scout"));
  const chat = within(await screen.findByRole("feed", { name: "Conversation with Scout" }));
  await userEvent.click(
    await chat.findByRole("button", { name: "Open research/2026-11-12-fares.md" }),
  );
  expect((await screen.findByLabelText("research/2026-11-12-fares.md")).textContent).toContain(
    "Lisbon is cheapest.",
  );
});

test("Settings › Spade tells Spade the person's zone and keeps the totals, not each bot's, and no cap", async () => {
  const { spade } = await spadeApp("/settings/spade", (api) => {
    seed(api);
    api.oversight.oversight.month_micros = 7_000_000;
  });
  const group = within(await screen.findByRole("region", { name: "Spending, every bot together" }));
  expect(await group.findByText("$7.00")).toBeTruthy();
  expect(group.queryByText(/cap/i)).toBeNull();
  // Scout's own spend is on its page.
  expect(group.queryByText("Scout")).toBeNull();
  await waitFor(() =>
    expect(spade.sent("PUT", "/v1/oversight")).toContainEqual({
      time_zone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    }),
  );
});

test("Show older goes on from where Spade stopped reading, past a part with nothing in it", async () => {
  const { spade } = await spadeApp("/spade", (api) => {
    seed(api);
    api.oversight.readsPerRequest = 1_000;
    api.oversight.activity.set("scout", [
      entry(5, { kind: "routine", name: "Daily briefing", summary: "9:00" }),
    ]);
    // A later entry far above it, so the first request reads only the newest part.
    api.oversight.activity
      .get("scout")
      ?.unshift(entry(4_000, { kind: "routine", name: "Evening digest", summary: "18:00" }));
  });
  await openActivity();
  const list = within(await screen.findByRole("list", { name: "Activity" }));
  expect(list.getAllByRole("listitem")).toHaveLength(1);
  await userEvent.click(await screen.findByRole("button", { name: "Show older" }));
  await waitFor(() => expect(activityReads(spade)).toContain("before=3001&limit=50"));
  // That part held nothing; the cursor still moves on, never repeating.
  await userEvent.click(await screen.findByRole("button", { name: "Show older" }));
  await userEvent.click(await screen.findByRole("button", { name: "Show older" }));
  await waitFor(() =>
    expect(
      within(screen.getByRole("list", { name: "Activity" })).getAllByRole("listitem"),
    ).toHaveLength(2),
  );
});

test("a new time zone reaches Spade when the window comes back, and spend is read again", async () => {
  const { spade } = await spadeApp("/settings/spade", seed);
  const first = Intl.DateTimeFormat().resolvedOptions().timeZone;
  await waitFor(() =>
    expect(spade.sent("PUT", "/v1/oversight")).toContainEqual({ time_zone: first }),
  );
  await screen.findByRole("region", { name: "Spending, every bot together" });
  const zone = first === "Asia/Tokyo" ? "Europe/Lisbon" : "Asia/Tokyo";
  const real = Intl.DateTimeFormat.prototype.resolvedOptions;
  vi.spyOn(Intl.DateTimeFormat.prototype, "resolvedOptions").mockImplementation(function (
    this: Intl.DateTimeFormat,
  ) {
    return { ...real.call(this), timeZone: zone };
  });
  const reads = () =>
    spade.requests.filter((r) => r.method === "GET" && r.path === "/v1/oversight").length;
  const before = reads();
  window.dispatchEvent(new Event("focus"));
  await waitFor(() =>
    expect(spade.sent("PUT", "/v1/oversight")).toContainEqual({ time_zone: zone }),
  );
  await waitFor(() => expect(reads()).toBeGreaterThan(before));
});
