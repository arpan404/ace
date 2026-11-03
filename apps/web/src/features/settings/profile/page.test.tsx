import { screen, waitFor, within } from "@testing-library/react";
import { expect, test } from "vitest";
import type { UsageSource } from "@ace/fake-daemon";
import { harness } from "@/test/harness.tsx";

const source = (provider: string, account: string, model: string) =>
  ({
    provider,
    account,
    model,
    daily: 80_000,
    steady: true,
    apiUsdPerMillion: 5,
    billing: "subscription",
    threads: [`thread-${provider}`],
  }) satisfies UsageSource;

test("Profile shows a year of this computer's work: totals, the grid, providers and the top model", async () => {
  const app = harness();
  app.daemon.services.usage.sources = [
    source("claude", "claude-personal", "claude-opus-4-6"),
    source("claude", "claude-personal", "claude-opus-4-6"),
    source("codex", "codex-personal", "gpt-5.3-codex"),
    source("claude", "claude-work", "claude-opus-4-6"),
  ];
  await app.open("/settings/profile");
  const providers = await screen.findByRole("region", { name: "Most used providers" });
  // Each provider account on its own, named by its account.
  await waitFor(() =>
    expect(
      within(providers)
        .getAllByRole("listitem")
        .map((tile) => tile.getAttribute("aria-label")),
    ).toEqual(["Claude Code, Personal, 50%", "Codex, Personal, 25%", "Claude Code, Work, 25%"]),
  );
  const insights = screen.getByRole("region", { name: "Insights" });
  // The model reads by its name, not its raw id.
  expect(within(insights).getByText(/· 75%$/).textContent).not.toContain("claude-opus-4-6");
  const grid = screen.getByRole("img", { name: /tokens over the last year/ });
  expect(grid.getAttribute("aria-label")).not.toMatch(/^0 tokens/);
  await waitFor(() =>
    expect(screen.getByText("Current streak").nextElementSibling?.textContent).not.toBe("0 days"),
  );
});

test("with no work yet, Profile says where activity will show instead of empty lists", async () => {
  const app = harness();
  app.daemon.services.usage.sources = [];
  await app.open("/settings/profile");
  expect(await screen.findByText("Your agents' work shows here as they run.")).toBeDefined();
  expect(screen.queryByRole("region", { name: "Most used providers" })).toBeNull();
  expect(screen.getByText("Active days").nextElementSibling?.textContent).toBe("0");
});
