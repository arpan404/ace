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
const codex: UsageSource = {
  provider: "codex",
  account: "codex-personal",
  model: "gpt-5.3-codex",
  daily: 80_000,
  steady: true,
  apiUsdPerMillion: 5,
  billing: "subscription",
  threads: ["thread-b"],
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
  at = Date.now(),
): UsageSessionTotal {
  return {
    counterKey,
    scope,
    model,
    at,
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
  timezone?: string;
}) {
  const app = harness();
  app.daemon.services.usage.sources = stage.sources;
  app.daemon.services.usage.sessions = stage.sessions ?? {};
  if (stage.timezone) app.daemon.services.usage.timezone = stage.timezone;
  await app.open("/accounts");
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
  // Claude's reported subscription tokens are valued at the current API list prices.
  expect((await stat("At API prices"))()).toEqual([
    "$4.91",
    "Leaves out 700K tokens without a price",
  ]);
  await waitFor(() =>
    expect(modelRow("Kimi K2")).toEqual(["Kimi K2", "OpenCode", "700K", "$0.0017", "Unavailable"]),
  );
  expect(modelRow("Opus 4.6")).toEqual(["Opus 4.6", "Claude Code", "700K", "Per session", "$4.91"]);
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
  expect(modelRow("Kimi K2")[4]).toBe("Unavailable");
  expect(screen.queryByText("$0.00")).toBeNull();
});

test("a session shared by a fork that switched provider counts once, for the provider that ran it", async () => {
  await openWeek({
    // The fork ran on Claude, then switched to Codex.
    sources: [
      { ...claude, threads: ["thread-a", "thread-fork"] },
      { ...codex, threads: ["thread-fork"] },
    ],
    sessions: {
      // The original holds an older snapshot of the shared session; the fork the latest.
      "thread-a": [
        snapshot("claude:s1:initial", "provider_session", "", 0.9),
        snapshot("claude:s1:initial", "model_session", "claude-opus-4-6", 0.9),
      ],
      "thread-fork": [
        snapshot("claude:s1:initial", "provider_session", "", 1),
        snapshot("claude:s1:initial", "model_session", "claude-opus-4-6", 1),
      ],
    },
  });

  const reported = await stat("Reported cost");
  await waitFor(() => expect(reported()).toEqual(["$1.00", "Claude Code $1.00 over 1 session"]));
});

test("a thread with more session totals than one read returns marks the reported cost partial", async () => {
  const sessions = Array.from({ length: 51 }, (_, index) => [
    snapshot(`claude:s${index}:initial`, "provider_session", "", 0.1),
    snapshot(`claude:s${index}:initial`, "model_session", "claude-opus-4-6", 0.1),
  ]).flat();
  await openWeek({ sources: [claude], sessions: { "thread-a": sessions } });

  const reported = await stat("Reported cost");
  await waitFor(() =>
    expect(reported()[1]).toContain("Partial: 1 thread had more sessions than one read returns"),
  );
});

test("sessions count from the start of the range in the daemon's time zone, not the device's", async () => {
  // The daemon counts days at UTC+14. The 7-day range starts at its midnight six days ago.
  const hour = 3_600_000;
  const day = 24 * hour;
  const start = (Math.floor((Date.now() + 14 * hour) / day) - 6) * day - 14 * hour;
  await openWeek({
    timezone: "Etc/GMT-14",
    sources: [claude],
    sessions: {
      "thread-a": [
        snapshot("claude:before:initial", "provider_session", "", 0.3, start - hour),
        snapshot("claude:within:initial", "provider_session", "", 0.05, start + hour),
      ],
    },
  });

  const reported = await stat("Reported cost");
  await waitFor(() => expect(reported()).toEqual(["$0.05", "Claude Code $0.05 over 1 session"]));
});

test("when usage by model can't be read, the page says so and reads it again on Try again", async () => {
  const app = harness();
  app.daemon.failRequests("usage.summary");
  await app.open("/accounts");

  const failed = (
    await screen.findByText("Usage by model couldn't be read.", {}, { timeout: 8000 })
  ).closest("[role=alert]");
  if (!(failed instanceof HTMLElement)) throw new Error("no alert");
  expect((await stat("At API prices"))()).toEqual([
    "Unavailable",
    "Usage by model couldn't be read",
  ]);
  expect(screen.queryByRole("table", { name: "Usage by model" })).toBeNull();

  app.daemon.restoreRequests();
  // Reported costs failed too and have their own Try again; this one reads usage by model.
  await userEvent.click(within(failed).getByRole("button", { name: "Try again" }));
  const table = await screen.findByRole("table", { name: "Usage by model" }, { timeout: 4000 });
  await waitFor(() => expect(within(table).getAllByRole("row")).toHaveLength(7));
});

test("usage rows show a known provider mark beside its readable name", async () => {
  await openWeek({ sources: [claude, opencode] });
  const table = await screen.findByRole("table", { name: "Usage by model" });
  expect(await within(table).findByRole("img", { name: "Claude Code" })).toBeTruthy();
  expect(await within(table).findByRole("img", { name: "OpenCode" })).toBeTruthy();
  expect(within(table).getByRole("cell", { name: "OpenCode" })).toBeTruthy();
});
