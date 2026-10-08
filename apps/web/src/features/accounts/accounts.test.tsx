import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { ScenarioPlayer, devWorld, teamAtLimit } from "@ace/fake-daemon";
import { harness } from "@/test/harness.tsx";

const card = (name: string) => screen.findByRole("article", { name });

test("each account shows its quota windows, and one with threads at its limit says when it resets", async () => {
  const app = harness();
  for (const scenario of teamAtLimit()) app.play(scenario).runThrough("limited");
  await app.open("/accounts");

  const personal = await card("Claude Code Personal");
  const fiveHour = within(personal).getByRole("meter", { name: "5-hour window" });
  expect(fiveHour.getAttribute("aria-valuenow")).toBe("62");

  const team = await card("Codex Team");
  expect(within(team).getByText("Limit reached")).toBeTruthy();
  expect(
    within(team).getByRole("meter", { name: "5-hour window" }).getAttribute("aria-valuenow"),
  ).toBe("100");
  expect(
    await within(team).findByText(/3 threads are paused until the window resets at \d{1,2}:\d\d/),
  ).toBeTruthy();
});

test("an account whose CLI reports no usage says so instead of showing an empty card", async () => {
  const app = harness();
  for (const scenario of teamAtLimit()) app.play(scenario).runThrough("limited");
  await app.open("/accounts");
  const opencode = await card("OpenCode Work");
  expect(within(opencode).queryByRole("meter")).toBeNull();
  expect(within(opencode).getByText("No limits reported yet")).toBeTruthy();
});

test("Move threads moves the limited threads where automatic recovery would: the provider's first available account", async () => {
  const app = harness();
  // This migration scenario has two signed-in isolated Codex accounts. The
  // normal CLI home is signed out and cannot receive a migrated conversation.
  const normal = app.daemon.services.accounts.find((account) => account.id === "codex-cli-default");
  if (!normal) throw new Error("missing normal Codex account");
  normal.availability = "logged_out";
  normal.quota.auth = "logged_out";
  for (const scenario of teamAtLimit()) app.play(scenario).runThrough("limited");
  await app.open("/accounts");
  const team = await card("Codex Team");

  await userEvent.click(await within(team).findByRole("button", { name: "Move running threads" }));

  expect(await screen.findByText("Moved 3 threads to Codex · Personal")).toBeTruthy();
  await waitFor(() =>
    expect(within(team).queryByRole("button", { name: "Move running threads" })).toBeNull(),
  );
  expect(await within(await card("Codex Personal")).findByText("3 running threads")).toBeTruthy();
  const list = app.daemon.snapshot({ kind: "threads" });
  const moved = list && "threads" in list ? Object.values(list.threads) : [];
  expect(
    moved
      .filter((thread) => thread.id.startsWith("thread-limit-"))
      .map((thread) => [thread.live?.account, thread.status.state]),
  ).toEqual([
    ["codex-personal", "working"],
    ["codex-personal", "working"],
    ["codex-personal", "working"],
  ]);
});

test("the run-out policy is the daemon's setting and is kept when you come back", async () => {
  const app = harness();
  await app.open("/accounts");
  const policy = await screen.findByRole("radiogroup", { name: "When an account runs out" });

  await userEvent.click(
    within(policy).getByRole("radio", { name: /Resume when the window resets/ }),
  );
  await waitFor(() =>
    expect(app.daemon.services.settings.get("threads.limitPolicy")).toBe("resume_at_reset"),
  );
  // Away through the sidebar, and back through the profile menu, its one way in.
  const sidebar = screen.getByRole("navigation", { name: "App" });
  await userEvent.click(within(sidebar).getByRole("link", { name: "Skills" }));
  await screen.findByRole("complementary", { name: "Skills" });
  await userEvent.click(screen.getByRole("button", { name: /^You, account/ }));
  await userEvent.click(await screen.findByRole("menuitem", { name: "Usage & accounts" }));

  const again = await screen.findByRole("radiogroup", { name: "When an account runs out" });
  await waitFor(() =>
    expect(
      within(again)
        .getByRole("radio", { name: /Resume when the window resets/ })
        .getAttribute("aria-checked"),
    ).toBe("true"),
  );
});

test("Refresh picks up quota the providers reported since the page opened", async () => {
  const app = harness();
  await app.open("/accounts");
  const work = await card("Claude Code Work");
  expect(
    within(work).getByRole("meter", { name: "5-hour window" }).getAttribute("aria-valuenow"),
  ).toBe("86");

  const reported = app.daemon.services.accounts.find((account) => account.id === "claude-work");
  if (!reported) throw new Error("missing the Work account");
  reported.quota.windows["five_hour"] = { usedPercent: 47, resetsAt: null };
  await userEvent.click(screen.getByRole("button", { name: "Refresh" }));

  await waitFor(async () =>
    expect(
      within(await card("Claude Code Work"))
        .getByRole("meter", { name: "5-hour window" })
        .getAttribute("aria-valuenow"),
    ).toBe("47"),
  );
});

test("usage shows a bar per day of the chosen range and totals by model", async () => {
  await harness().open("/accounts");
  const days = await screen.findByRole("list", { name: "Tokens per day" });
  await waitFor(() => expect(within(days).getAllByRole("listitem")).toHaveLength(14));

  await userEvent.click(screen.getByRole("button", { name: "7 days" }));
  await waitFor(() =>
    expect(
      within(screen.getByRole("list", { name: "Tokens per day" })).getAllByRole("listitem"),
    ).toHaveLength(7),
  );
  const table = screen.getByRole("table", { name: "Usage by model" });
  const models = within(table)
    .getAllByRole("row")
    .slice(1)
    .map((row) => within(row).getAllByRole("cell")[0]?.textContent);
  expect(models[0]).toBe("Opus 4.6");
  expect(models).toHaveLength(6);
});

test("accounts are managed from their provider page", async () => {
  await harness().open("/accounts");
  await userEvent.click(await screen.findByRole("link", { name: "Codex" }));
  const accounts = await screen.findByRole("list", { name: "Codex accounts" });
  await userEvent.click(within(accounts).getByRole("button", { name: "Add account" }));
  expect(await screen.findByRole("form", { name: "Add account" })).toBeTruthy();
});

test("when the daemon can't list accounts, the page says so in words and reads them again on Try again", async () => {
  const app = harness();
  app.daemon.failRequests("accounts.list");
  await app.open("/accounts");

  expect(
    await screen.findByText(
      "ace didn't answer. This loads again once it does.",
      {},
      { timeout: 4000 },
    ),
  ).toBeTruthy();
  expect(screen.queryByText("unavailable")).toBeNull();
  app.daemon.restoreRequests();
  await userEvent.click(screen.getByRole("button", { name: "Try again" }));
  expect(await card("Claude Code Personal")).toBeTruthy();
});

test("in the development world each account counts the threads running on it", async () => {
  const app = harness();
  for (const thread of devWorld()) {
    const player = new ScenarioPlayer(app.daemon, thread.scenario, { agoMs: thread.agoMs });
    if (thread.through) player.runThrough(thread.through);
    else player.runUntilBlocked();
  }
  await app.open("/accounts");

  const personal = await card("Claude Code Personal");
  expect(await within(personal).findByText(/^\d+ running threads?$/)).toBeTruthy();
  const work = await card("Claude Code Work");
  expect(await within(work).findByText(/^\d+ running threads?$/)).toBeTruthy();
});
