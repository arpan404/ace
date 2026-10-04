import type { UsageSessionTotal, UsageSource } from "@ace/fake-daemon";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

/*
 * Steady sources: 80,000 input and 20,000 output tokens a day, so a week is 700K tokens and a
 * price of P per million comes to 0.1 × P dollars a day.
 */
const claude: UsageSource = {
  provider: "claude",
  account: "claude-personal",
  model: "claude-opus-4-6",
  daily: 80_000,
  steady: true,
  apiUsdPerMillion: 15,
  billing: "subscription",
  threads: ["thread-a"],
};
const opencode: UsageSource = {
  provider: "opencode",
  account: "opencode-api",
  model: "opencode/kimi-k2",
  daily: 80_000,
  steady: true,
  // ace has no list price for it; OpenCode reports $0.00024 a day, $0.00168 a week.
  apiUsdPerMillion: null,
  reportedUsdPerMillion: 0.0024,
  billing: "api",
  threads: ["thread-b"],
};

function snapshot(
  counterKey: string,
  scope: UsageSessionTotal["scope"],
  model: string,
  costUsd: number,
): UsageSessionTotal {
  return {
    counterKey,
    scope,
    model,
    at: Date.now(),
    inputTokens: 40_000,
    outputTokens: 2_000,
    cachedInputTokens: 30_000,
    cacheWriteTokens: 4_000,
    cacheWrite1hTokens: 0,
    costUsd,
  };
}

/** The Usage section over the last 7 days, with the daemon reporting `stage`'s usage. */
async function openWeek(stage: {
  sources: UsageSource[];
  sessions?: Record<string, UsageSessionTotal[]>;
}) {
  const app = harness();
  app.daemon.services.usage.sources = stage.sources;
  app.daemon.services.usage.sessions = stage.sessions ?? {};
  await app.open("/more/accounts");
  await userEvent.click(await screen.findByRole("button", { name: "7 days" }));
  return app;
}

/** A figure in the summary row: its value and the note under it. */
async function stat(label: string) {
  const term = await screen.findByText(label, { selector: "dt" });
  const figure = term.parentElement;
  if (!figure) throw new Error(`no figure for ${label}`);
  return () => [...figure.querySelectorAll("dd")].map((value) => value.textContent);
}

function modelRow(model: string) {
  const table = screen.getByRole("table", { name: "Usage by model" });
  const row = within(table).getByRole("cell", { name: model }).closest("tr");
  if (!row) throw new Error(`no row for ${model}`);
  return within(row)
    .getAllByRole("cell")
    .map((cell) => cell.textContent);
}

test("what OpenCode and Claude reported shows apart from the API-price estimate", async () => {
  await openWeek({
    sources: [claude, opencode],
    sessions: {
      "thread-a": [
        snapshot("claude:s1:initial", "provider_session", "", 0.081),
        snapshot("claude:s1:initial", "model_session", "claude-opus-4-6", 0.06),
        snapshot("claude:s1:initial", "model_session", "claude-haiku-4-5", 0.021),
      ],
    },
  });

  const reported = await stat("Reported cost");
  await waitFor(() =>
    expect(reported()).toEqual(["$0.08", "Claude Code $0.08 over 1 session · OpenCode $0.0017"]),
  );
  // Only Claude's tokens have a list price: 7 days × $1.50.
  expect((await stat("At API prices"))()).toEqual([
    "$10.50",
    "Leaves out 700K tokens without a price",
  ]);
  await waitFor(() =>
    expect(modelRow("opencode/kimi-k2")).toEqual([
      "opencode/kimi-k2",
      "OpenCode",
      "700K",
      "$0.0017",
      "Unavailable",
    ]),
  );
  expect(modelRow("claude-opus-4-6")).toEqual([
    "claude-opus-4-6",
    "Claude Code",
    "700K",
    "Per session",
    "$10.50",
  ]);
});

test("a Claude session's total counts once, beside its per-model totals and in a fork that shares it", async () => {
  await openWeek({
    sources: [{ ...claude, threads: ["thread-a", "thread-fork"] }],
    sessions: {
      "thread-a": [
        snapshot("claude:s1:initial", "provider_session", "", 0.081),
        snapshot("claude:s1:initial", "model_session", "claude-opus-4-6", 0.06),
        snapshot("claude:s1:initial", "model_session", "claude-haiku-4-5", 0.021),
      ],
      "thread-fork": [
        snapshot("claude:s1:initial", "provider_session", "", 0.081),
        // A later session whose provider total never arrived: its model totals stand in.
        snapshot("claude:s2:initial", "model_session", "claude-opus-4-6", 0.04),
      ],
    },
  });

  const reported = await stat("Reported cost");
  await waitFor(() => expect(reported()).toEqual(["$0.12", "Claude Code $0.12 over 2 sessions"]));
});

test("usage without API prices reads unavailable instead of costing $0.00", async () => {
  await openWeek({ sources: [opencode] });

  const api = await stat("At API prices");
  await waitFor(() => expect(api()).toEqual(["Unavailable", "No API prices for these models"]));
  expect(modelRow("opencode/kimi-k2")[4]).toBe("Unavailable");
  expect(screen.queryByText("$0.00")).toBeNull();
});
