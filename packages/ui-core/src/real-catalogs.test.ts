import { expect, test } from "vitest";
import { AccountSummary } from "@ace/protocol/accounts";
import { accountView, accountStatus, catalogSignal, providerAccountModel } from "./index.ts";

test.each([
  [{ windowDurationMins: 10080, resetsAt: 1000 }, "Weekly"],
  [{ windowDurationMins: 300, resetsAt: 1000 }, "5-hour"],
  [{ resetsAt: 5 * 86400000 }, "Weekly"],
  [{ resetsAt: null }, "Usage"],
])("Codex window labels follow reported periods instead of primary slot names", (period, label) => {
  const account = accountView(
    AccountSummary.parse({
      id: "codex-personal",
      provider: "codex",
      label: "Personal",
      availability: "available",
      quota: {
        auth: "logged_in",
        observedAt: 0,
        windows: { "codex:primary": { usedPercent: 7, ...period } },
        usage: {},
      },
    }),
  );
  expect(account.windows.map((window) => window.label)).toEqual([label]);
});

test("model-specific Claude weekly windows keep their names when a duration is reported", () => {
  const account = accountView(
    AccountSummary.parse({
      id: "claude-personal",
      provider: "claude",
      label: "Personal",
      availability: "available",
      quota: {
        auth: "logged_in",
        observedAt: 0,
        windows: {
          seven_day_opus: { usedPercent: 20, resetsAt: 1000, windowDurationMins: 10080 },
          seven_day_sonnet: { usedPercent: 30, resetsAt: 1000, windowDurationMins: 10080 },
        },
        usage: {},
      },
    }),
  );
  expect(account.windows.map((window) => window.label)).toEqual(["Weekly Opus", "Weekly Sonnet"]);
});

test("an empty connected source keeps the account and provider green while a sibling serves models", () => {
  const source = { kind: "subscription" as const, id: "opencode-go", label: "OpenCode Go" };
  const signal = catalogSignal(
    [{ provider: "opencode", instance: "personal", source }],
    [
      {
        provider: "opencode",
        instance: "personal",
        status: "fresh",
        stale: false,
        refreshing: false,
        sources: [
          { source, status: "fresh" },
          {
            source: { ...source, id: "github-copilot", label: "GitHub Copilot" },
            status: "fresh",
            error: { code: "no_models", message: "No models enabled", hint: "Refresh" },
          },
        ],
      },
    ],
    "opencode",
  );
  const model = providerAccountModel({
    provider: "opencode",
    now: 10,
    accounts: [
      accountView(
        AccountSummary.parse({
          id: "personal",
          provider: "opencode",
          label: "Personal",
          implicit: true,
          availability: "available",
          quota: { auth: "unknown", observedAt: 1, windows: {}, usage: {} },
        }),
      ),
    ],
    catalog: signal,
    catalogForAccount: () => signal,
    row: {
      provider: "opencode",
      runtime: "cli",
      installed: true,
      auth: "unknown",
      readiness: "needs_attention",
      loginHint: "",
      stale: false,
      refreshing: false,
    },
  });
  expect(model.view).toMatchObject({ ready: true, tone: "ready", primary: undefined });
  const account = model.accounts[0];
  if (!account) throw new Error("Missing account");
  expect(accountStatus(account, 10)).toMatchObject({ canRun: true, tone: "ready", text: "Ready" });
});
