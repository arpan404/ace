import type { FakeSpadeApi } from "@ace/fake-daemon";
import { configure, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";
import { botRow, spadeApp, withEndpoint } from "@/test/spade.ts";

configure({ asyncUtilTimeout: 10_000 });
beforeEach(() => localStorage.clear());

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
  await openMenu("Activity");
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
  await openMenu("Activity");
  await userEvent.click(await screen.findByRole("button", { name: "Show older" }));
  await waitFor(() => expect(activityReads(spade)).toContain("before=2&limit=100"));
  await waitFor(() =>
    expect(
      within(screen.getByRole("list", { name: "Activity" })).getAllByRole("listitem"),
    ).toHaveLength(101),
  );
  expect(screen.queryByRole("button", { name: "Show older" })).toBeNull();
});

test("the edit form shows what a bot spent and saves its caps in micros and its review", async () => {
  const { spade } = await spadeApp("/spade", seed);
  await openMenu("Edit bot");
  const form = within(await screen.findByRole("dialog", { name: "Edit Scout" }));
  expect(form.getByText("$0.42 today · $3.10 this month")).toBeTruthy();
  const daily = form.getByRole("textbox", { name: "Daily cap" });
  expect((daily as HTMLInputElement).value).toBe("1");
  await userEvent.clear(daily);
  await userEvent.type(daily, "2.50");
  await userEvent.type(form.getByRole("textbox", { name: "Monthly cap" }), "40");
  await userEvent.click(form.getByRole("button", { name: "On" }));
  await userEvent.click(form.getByRole("button", { name: "Save" }));
  await waitFor(() =>
    expect(spade.sent("PUT", "/v1/agents/scout/oversight")).toEqual([
      { daily_cap_micros: 2_500_000, monthly_cap_micros: 40_000_000, review: true },
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

test("Settings › Spade tells Spade the person's zone and shows each bot's spend and caps", async () => {
  const { spade } = await spadeApp("/settings/spade", seed);
  const group = within(await screen.findByRole("region", { name: "Spending and review" }));
  expect(await group.findByText("$0.42 today · $3.10 this month · Caps $1.00 a day")).toBeTruthy();
  expect(group.getByText("Daily cap $5.00")).toBeTruthy();
  await waitFor(() =>
    expect(spade.sent("PUT", "/v1/oversight")).toContainEqual({
      time_zone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    }),
  );
  await userEvent.click(group.getByRole("switch", { name: "Review every bot's steps" }));
  await waitFor(() =>
    expect(spade.sent("PUT", "/v1/oversight")).toContainEqual({ review_default: true }),
  );
});
