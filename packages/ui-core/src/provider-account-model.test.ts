import { expect, test } from "vitest";
import { AccountSummary } from "@ace/protocol/accounts";
import type { ProviderStatus } from "@ace/protocol";
import { accountView, accountStatus, providerAccountModel } from "./index.ts";

const row: ProviderStatus = {
  provider: "codex",
  runtime: "cli",
  installed: true,
  auth: "logged_out",
  loginHint: "",
  stale: false,
  refreshing: false,
};
const account = (
  id: string,
  auth: "logged_in" | "logged_out" | "unknown",
  used = 38,
  implicit = false,
) =>
  accountView(
    AccountSummary.parse({
      id,
      provider: "codex",
      label: id,
      implicit,
      availability: "unknown",
      quota: {
        auth,
        observedAt: 1,
        windows: { daily: { usedPercent: used, resetsAt: 100 } },
        blockers: {},
        usage: {},
      },
    }),
  );

test("a signed-out default never asks for sign-in while another account can run", () => {
  const model = providerAccountModel({
    provider: "codex",
    row,
    now: 10,
    accounts: [account("Personal", "logged_in"), account("normal", "unknown", 0, true)],
  });
  expect(model.view?.summary).toBe("Signed in · Personal");
  expect(model.view?.primary).toBeUndefined();
  expect(model.accounts.map((entry) => accountStatus(entry, 10).text)).toEqual([
    "Signed out",
    "Signed in",
  ]);
});

test("discovery clarifies the normal profile without signing in isolated accounts or erasing its limits", () => {
  const model = providerAccountModel({
    provider: "codex",
    row: { ...row, auth: "logged_in", accountLabel: "Ada" },
    now: 10,
    accounts: [account("normal", "unknown", 100, true), account("Work", "logged_out")],
  });
  expect(model.view?.label).toBe("Limit reached");
  expect(model.view?.primary).toBeUndefined();
  expect(model.accounts.map((entry) => [entry.label, accountStatus(entry, 10).text])).toEqual([
    ["Ada", "Limit reached"],
    ["Work", "Signed out"],
  ]);
  expect(model.accounts[0]?.windows[0]?.usedPercent).toBe(100);
});

test("an expired quota window allows work again without a new login", () => {
  const accounts = [account("Personal", "logged_in", 100)];
  expect(providerAccountModel({ provider: "codex", row, accounts, now: 10 }).view?.ready).toBe(
    false,
  );
  expect(providerAccountModel({ provider: "codex", row, accounts, now: 100 }).view?.ready).toBe(
    true,
  );
});

test("unreported CLI authentication stays unknown until its model evidence says it works", () => {
  const input = {
    provider: "codex" as const,
    row: { ...row, auth: "unknown" as const },
    accounts: [account("normal", "unknown", 0, true)],
    now: 10,
  };
  const pending = providerAccountModel(input);
  expect(pending.view?.ready).toBe(false);
  expect(accountStatus(pending.accounts[0] ?? account("missing", "unknown"), 10).canRun).toBe(
    false,
  );
  const ready = providerAccountModel({ ...input, catalog: { models: true, connected: 0 } });
  expect(ready.view?.ready).toBe(true);
  expect(accountStatus(ready.accounts[0] ?? account("missing", "unknown"), 10).text).toBe("Ready");
});

test("missing runtimes and unfinished account reads never advertise a usable provider", () => {
  const accounts = [account("Personal", "logged_in")];
  const missing = providerAccountModel({
    provider: "codex",
    row: { ...row, installed: false },
    accounts,
    now: 10,
  });
  expect(missing.view?.label).toBe("Not installed");
  expect(
    accountStatus(missing.accounts[0] ?? accounts[0] ?? account("missing", "unknown"), 10).canRun,
  ).toBe(false);
  expect(
    providerAccountModel({ provider: "codex", row, accounts: undefined, now: 10 }).view,
  ).toBeUndefined();
});

test("model evidence never bypasses a live limit on an unreported login", () => {
  const model = providerAccountModel({
    provider: "codex",
    row: { ...row, auth: "unknown" },
    now: 10,
    accounts: [account("normal", "unknown", 100, true)],
    catalog: { models: true, connected: 0 },
  });
  expect(model.view?.label).toBe("Limit reached");
  expect(model.view?.ready).toBe(false);
  expect(model.view?.primary).toBeUndefined();
});

test("OpenCode can offer credential-free models while its normal profile is signed out", () => {
  const normal = { ...account("normal", "logged_out", 0, true), provider: "opencode" as const };
  const model = providerAccountModel({
    provider: "opencode",
    now: 10,
    accounts: [normal],
    row: { ...row, provider: "opencode", modelsAvailable: true },
  });
  expect(model.view?.ready).toBe(true);
  expect(model.view?.summary).toBe("Ready · Your CLI login");
  expect(model.view?.primary).toBeUndefined();
  expect(accountStatus(model.accounts[0] ?? normal, 10).canRun).toBe(true);
});
