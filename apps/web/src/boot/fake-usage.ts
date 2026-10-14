import type { FakeDaemon } from "@ace/fake-daemon";

const hour = 3_600_000;

/**
 * The build server's own usage, so Usage's environment filter has something to tell apart: one
 * Codex login ("CI") with its own limits and banked resets, and a steady share of Codex tokens.
 */
export function seedBuildServerUsage(server: FakeDaemon, now: number): void {
  const services = server.services;
  const codex = services.accounts.find((account) => account.id === "codex-personal");
  if (codex)
    services.accounts = [
      {
        ...codex,
        id: "codex-ci",
        label: "CI",
        shortLabel: "C",
        quota: {
          ...codex.quota,
          resetCredits: { available: 2, nextExpiresAt: now + 20 * 24 * hour },
          windows: {
            "codex:primary": {
              usedPercent: 71,
              resetsAt: now + 2 * hour + 14 * 60_000,
              windowDurationMins: 300,
              source: "cli",
            },
            "codex:secondary": {
              usedPercent: 46,
              resetsAt: now + 3 * 24 * hour,
              windowDurationMins: 10080,
              source: "cli",
            },
          },
        },
      },
    ];
  services.usage.sources = [
    {
      provider: "codex",
      account: "codex-ci",
      model: "gpt-5.3-codex",
      daily: 1_900_000,
      apiUsdPerMillion: 5,
      billing: "subscription",
      threads: ["ci-nightly", "ci-flake-triage", "ci-deps", "ci-release-notes"],
    },
  ];
}

/**
 * Limit readings as a real Mac has them: Claude's Fable weekly window (which Claude reports
 * only during a turn) beside its 5-hour and weekly ones, and a Work 5-hour reading taken three
 * hours ago whose window has since reset.
 */
export function seedLimitReadings(daemon: FakeDaemon, now: number): void {
  const accounts = daemon.services.accounts;
  const personal = accounts.find((account) => account.id === "claude-personal");
  if (personal)
    personal.quota.windows["seven_day_overage_included"] = {
      usedPercent: 27,
      resetsAt: now + 4 * 24 * hour,
      source: "cli",
      observedAt: now - 20 * 60_000,
    };
  const work = accounts.find((account) => account.id === "claude-work");
  const five = work?.quota.windows["five_hour"];
  if (work && five)
    work.quota.windows["five_hour"] = { ...five, resetsAt: now - hour, observedAt: now - 3 * hour };
}
