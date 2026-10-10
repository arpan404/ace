import { configure, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

configure({ asyncUtilTimeout: 10_000 });

const card = (name: string) => screen.findByRole("article", { name });

test("Usage groups limited and at least eighty-percent accounts ahead of everything else", async () => {
  const app = harness();
  const personal = app.daemon.services.accounts.find((account) => account.id === "claude-personal");
  if (!personal) throw new Error("Missing account fixture");
  personal.quota.windows = { five_hour: { usedPercent: 80, resetsAt: null } };
  await app.open("/accounts");
  const closest = await screen.findByRole("region", { name: "Closest to a limit" });
  expect(await within(closest).findByRole("article", { name: "Codex Team" })).toBeTruthy();
  expect(within(closest).getByRole("article", { name: "Claude Code Personal" })).toBeTruthy();
  expect(within(closest).getByRole("article", { name: "Claude Code Work" })).toBeTruthy();
  expect(
    within(await screen.findByRole("region", { name: "Everything else" })).getByRole("article", {
      name: "Codex Personal",
    }),
  ).toBeTruthy();
  expect(
    within(await card("Codex Team"))
      .getByRole("meter", { name: "5-hour window" })
      .getAttribute("aria-valuenow"),
  ).toBe("100");
});

test("Usage has no account-management actions and directs management to Providers", async () => {
  await harness().open("/accounts");
  await card("Codex Personal");
  expect(
    screen.queryByRole("button", { name: /Add account|Manage .*|Make default|Remove|Rename/ }),
  ).toBeNull();
  await userEvent.click(
    screen.getByRole("link", { name: "Manage accounts in Settings › Providers." }),
  );
  await userEvent.click(await screen.findByRole("link", { name: "Codex" }));
  await userEvent.click(
    await screen.findByRole("button", { name: "+ Add account" }, { timeout: 10_000 }),
  );
  expect(await screen.findByRole("dialog", { name: "Add a Codex account" })).toBeTruthy();
});

test("accounts without readings use a quiet state instead of empty meters", async () => {
  await harness().open("/accounts");
  const opencode = await card("OpenCode Work");
  expect(within(opencode).queryByRole("meter")).toBeNull();
  expect(within(opencode).getByText(/No limits|Not reported yet/)).toBeTruthy();
});

test("Refresh updates percentages and moves an account below eighty percent into Everything else", async () => {
  const app = harness();
  await app.open("/accounts");
  const work = await card("Claude Code Work");
  expect(
    within(work).getByRole("meter", { name: "5-hour window" }).getAttribute("aria-valuenow"),
  ).toBe("86");
  const reported = app.daemon.services.accounts.find((account) => account.id === "claude-work");
  if (!reported) throw new Error("Missing Work account");
  reported.quota.windows.five_hour = { usedPercent: 79, resetsAt: null };
  await userEvent.click(screen.getByRole("button", { name: "Refresh" }));
  await waitFor(() =>
    expect(
      within(screen.getByRole("region", { name: "Everything else" })).getByRole("article", {
        name: "Claude Code Work",
      }),
    ).toBeTruthy(),
  );
});

test("usage keeps daily totals and models available below the limits", async () => {
  await harness().open("/accounts");
  const days = await screen.findByRole("list", { name: "Tokens per day" });
  await waitFor(() => expect(within(days).getAllByRole("listitem")).toHaveLength(14));
  await userEvent.click(screen.getByRole("button", { name: "7 days" }));
  await waitFor(() => expect(within(days).getAllByRole("listitem")).toHaveLength(7));
  expect(
    within(screen.getByRole("table", { name: "Usage by model" })).getByText("Opus 4.6"),
  ).toBeTruthy();
});

test("failed usage reads explain what happened and Try again recovers", async () => {
  const app = harness();
  app.daemon.failRequests("accounts.list");
  await app.open("/accounts");
  await screen.findByText("Couldn't load usage", {}, { timeout: 4000 });
  app.daemon.restoreRequests();
  await userEvent.click(screen.getByRole("button", { name: "Try again" }));
  expect(await card("Claude Code Personal")).toBeTruthy();
});

test("running threads are available in a tooltip without adding another line to the account", async () => {
  await harness().open("/accounts");
  const personal = await card("Claude Code Personal");
  await userEvent.hover(within(personal).getByText("Claude Code · Personal"));
  expect(
    await screen.findByRole("tooltip", { name: /running threads.*threads at a limit/ }),
  ).toBeTruthy();
  expect(within(personal).queryByText(/running threads/)).toBeNull();
});

test("a provider limit without meter readings never claims No limits", async () => {
  const app = harness();
  const account = app.daemon.services.accounts.find(
    (row) => row.provider === "opencode" && row.label === "Work",
  );
  if (!account) throw new Error("Missing OpenCode account fixture");
  account.quota.blockers.limitError = { usedPercent: 100, resetsAt: null };
  await app.open("/accounts");
  const closest = await screen.findByRole("region", { name: "Closest to a limit" });
  const row = await within(closest).findByRole("article", { name: "OpenCode Work" });
  expect(within(row).getByText("Limit reached")).toBeTruthy();
  expect(within(row).queryByText("No limits")).toBeNull();
});
