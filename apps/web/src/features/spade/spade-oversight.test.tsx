import type { FakeSpadeApi } from "@ace/fake-daemon";
import { configure, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { botRow, spadeApp, withEndpoint } from "@/test/spade.ts";

configure({ asyncUtilTimeout: 10_000 });
beforeEach(() => localStorage.clear());
afterEach(() => vi.restoreAllMocks());

const spending = {
  today_micros: 420_000,
  month_micros: 3_100_000,
  daily_cap_micros: 1_000_000,
  monthly_cap_micros: null,
  capped: null,
  resets_at: null,
};

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

/** Scout's whole activity: from its page's Activity section, All. */
async function openActivity() {
  await userEvent.click(await botRow("Scout"));
  await userEvent.click(await screen.findByRole("link", { name: /^Scout on .*open its page$/ }));
  const section = within(await screen.findByRole("region", { name: "Activity" }));
  await userEvent.click(section.getByRole("button", { name: "All" }));
}

async function openMenu(item: string) {
  await userEvent.click(await botRow("Scout"));
  await userEvent.click(await screen.findByRole("button", { name: "More actions" }));
  await userEvent.click(await screen.findByRole("menuitem", { name: item }));
}

test("a bot's activity lists what it did newest first, and its filters and search ask Spade for just that", async () => {
  const { spade } = await spadeApp("/spade", (api) => {
    seed(api);
    api.oversight.activity.set("scout", [
      entry(3, {
        kind: "tool",
        name: "web_fetch",
        summary: "url: https://example.com/fares",
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
        outcome: "ok",
      }),
    ]);
  });
  await openActivity();
  const list = within(await screen.findByRole("list", { name: "Activity" }));
  await waitFor(() =>
    expect(list.getAllByRole("listitem").map((row) => row.textContent)).toEqual([
      expect.stringMatching(/Read a web pageurl: https:\/\/example\.com\/faresFailed$/),
      expect.stringMatching(/Finished a turn3 steps\$0\.02$/),
      expect.stringMatching(/Searched the webquery: flights to LisbonDone$/),
    ]),
  );
  // Nothing of this is in the chat.
  expect(screen.queryByRole("feed")).toBeNull();

  await userEvent.click(screen.getByRole("button", { name: "Tools" }));
  await waitFor(() => expect(activityReads(spade).at(-1)).toBe("kind=tool&limit=100"));
  await userEvent.type(screen.getByRole("searchbox", { name: "Search activity" }), "lisbon");
  await waitFor(() => expect(activityReads(spade).at(-1)).toBe("kind=tool&q=lisbon&limit=100"));
  await waitFor(() =>
    expect(
      within(screen.getByRole("list", { name: "Activity" }))
        .getAllByRole("listitem")
        .map((row) => row.textContent),
    ).toEqual([expect.stringContaining("Searched the web")]),
  );
});

test("Show older reads the page before the last entry shown", async () => {
  const { spade } = await spadeApp("/spade", (api) => {
    seed(api);
    api.oversight.activity.set(
      "scout",
      Array.from({ length: 101 }, (_, index) =>
        entry(101 - index, { kind: "routine", name: `Run ${101 - index}`, summary: "9:00" }),
      ),
    );
  });
  await openActivity();
  await userEvent.click(await screen.findByRole("button", { name: "Show older" }));
  await waitFor(() => expect(activityReads(spade)).toContain("before=2&limit=100"));
  await waitFor(() =>
    expect(
      within(screen.getByRole("list", { name: "Activity" })).getAllByRole("listitem"),
    ).toHaveLength(101),
  );
  expect(screen.queryByRole("button", { name: "Show older" })).toBeNull();
});

test("the edit form shows what a bot spent and saves its caps in micros", async () => {
  const { spade } = await spadeApp("/spade", seed);
  await openMenu("Edit bot");
  const form = within(await screen.findByRole("dialog", { name: "Edit Scout" }));
  expect(form.getByText("$0.42 today · $3.10 this month")).toBeTruthy();
  const daily = form.getByRole("textbox", { name: "Daily cap" });
  expect((daily as HTMLInputElement).value).toBe("1");
  await userEvent.clear(daily);
  await userEvent.type(daily, "2.50");
  await userEvent.type(form.getByRole("textbox", { name: "Monthly cap" }), "40");
  await userEvent.click(form.getByRole("button", { name: "Save" }));
  await waitFor(() =>
    expect(spade.sent("PUT", "/v1/agents/scout/oversight")).toEqual([
      { daily_cap_micros: 2_500_000, monthly_cap_micros: 40_000_000 },
    ]),
  );
});

test("clearing a cap sends no cap, and a cap that isn't dollars can't be saved", async () => {
  const { spade } = await spadeApp("/spade", seed);
  await openMenu("Edit bot");
  const form = within(await screen.findByRole("dialog", { name: "Edit Scout" }));
  const daily = form.getByRole("textbox", { name: "Daily cap" });
  await userEvent.clear(daily);
  await userEvent.type(daily, "lots");
  expect(form.getByRole("button", { name: "Save" }).hasAttribute("disabled")).toBe(true);
  await userEvent.clear(daily);
  await userEvent.click(form.getByRole("button", { name: "Save" }));
  await waitFor(() =>
    expect(spade.sent("PUT", "/v1/agents/scout/oversight")).toEqual([{ daily_cap_micros: null }]),
  );
});

test("a bot at its cap says so on its row, and its cap bubble shows once in the chat", async () => {
  await spadeApp("/spade", (api) => {
    const scout = seed(api);
    scout.spending = { ...spending, capped: "daily", resets_at: at + 86_400_000 };
    const cap = { type: "cap_reached", scope: "daily", cap_micros: 1_000_000, period_start: at };
    api.store(scout.conversation, cap);
    api.store(scout.conversation, cap);
  });
  expect((await botRow("Scout")).textContent).toContain("At its daily cap");
  await userEvent.click(await botRow("Scout"));
  const chat = within(await screen.findByRole("feed", { name: "Conversation with Scout" }));
  await waitFor(() =>
    expect(chat.getAllByText(/reached my daily spending cap of \$1\.00/)).toHaveLength(1),
  );
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

test("Settings › Spade tells Spade the person's zone and keeps the totals and the cap, not each bot's", async () => {
  const { spade } = await spadeApp("/settings/spade", seed);
  const group = within(await screen.findByRole("region", { name: "Spending and review" }));
  expect(await group.findByText("Daily cap $5.00")).toBeTruthy();
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
  await waitFor(() => expect(activityReads(spade)).toContain("before=3001&limit=100"));
  // That part held nothing; the cursor still moves on, never repeating.
  await userEvent.click(await screen.findByRole("button", { name: "Show older" }));
  await userEvent.click(await screen.findByRole("button", { name: "Show older" }));
  await waitFor(() =>
    expect(
      within(screen.getByRole("list", { name: "Activity" })).getAllByRole("listitem"),
    ).toHaveLength(2),
  );
});

test("a cap under a cent reopens as typed, and saving the name never rewrites a cap", async () => {
  const { spade } = await spadeApp("/spade", (api) => {
    withEndpoint(api);
    api.addAgent({ id: "main", kind: "main", name: "Spade", avatar: { kind: "spade" } });
    api.addAgent({
      id: "scout",
      name: "Scout",
      spending: { ...spending, daily_cap_micros: 1_000 },
    });
  });
  await openMenu("Edit bot");
  const form = within(await screen.findByRole("dialog", { name: "Edit Scout" }));
  expect((form.getByRole("textbox", { name: "Daily cap" }) as HTMLInputElement).value).toBe(
    "0.001",
  );
  const name = form.getByRole("textbox", { name: "Name" });
  await userEvent.clear(name);
  await userEvent.type(name, "Scout Two");
  await userEvent.click(form.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(spade.sent("PATCH", "/v1/agents/scout")).toHaveLength(1));
  expect(spade.sent("PUT", "/v1/agents/scout/oversight")).toEqual([]);
});

test("a cap too large to store can't be saved instead of clearing the cap", async () => {
  const { spade } = await spadeApp("/spade", seed);
  await openMenu("Edit bot");
  const form = within(await screen.findByRole("dialog", { name: "Edit Scout" }));
  const daily = form.getByRole("textbox", { name: "Daily cap" });
  await userEvent.clear(daily);
  await userEvent.click(daily);
  await userEvent.paste("9".repeat(400));
  expect(form.getByRole("button", { name: "Save" }).hasAttribute("disabled")).toBe(true);
  expect(spade.sent("PUT", "/v1/agents/scout/oversight")).toEqual([]);
});

test("a new time zone reaches Spade when the window comes back, and spend is read again", async () => {
  const { spade } = await spadeApp("/settings/spade", seed);
  const first = Intl.DateTimeFormat().resolvedOptions().timeZone;
  await waitFor(() =>
    expect(spade.sent("PUT", "/v1/oversight")).toContainEqual({ time_zone: first }),
  );
  await screen.findByRole("region", { name: "Spending and review" });
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
