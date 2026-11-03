import { screen, waitFor, within } from "@testing-library/react";
import { expect, test } from "vitest";
import type { UsageSource } from "@ace/fake-daemon";
import { harness } from "@/test/harness.tsx";

const source = (provider: string, model: string) =>
  ({
    provider,
    account: `${provider}-personal`,
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
    source("claude", "claude-opus-4-6"),
    source("claude", "claude-opus-4-6"),
    source("codex", "gpt-5.3-codex"),
  ];
  await app.open("/settings/profile");
  const providers = await screen.findByRole("region", { name: "Top providers" });
  const tiles = within(providers).getAllByRole("listitem");
  expect(tiles.map((tile) => tile.textContent)).toEqual(["Claude Code67%", "Codex33%"]);
  const insights = screen.getByRole("region", { name: "Insights" });
  // The model reads by its name, not its raw id.
  expect(within(insights).getByText(/· 67%$/).textContent).not.toContain("claude-opus-4-6");
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
  expect(screen.queryByRole("region", { name: "Top providers" })).toBeNull();
  expect(screen.getByText("Active days").nextElementSibling?.textContent).toBe("0");
});
