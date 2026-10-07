import { expect, test } from "vitest";
import { onboardingChecklist, providerReadiness } from "./index.ts";
import type { ProviderStatus } from "@ace/protocol";
const row: ProviderStatus = {
  provider: "codex",
  runtime: "cli",
  installed: true,
  auth: "logged_out",
  loginHint: "codex login",
  stale: false,
  refreshing: false,
};

test("first run recommends sign-in for installed CLIs and starting work once one is ready", () => {
  expect(onboardingChecklist([row])).toMatchObject({
    ready: [],
    next: { action: "sign_in", provider: "codex" },
  });
  expect(onboardingChecklist([{ ...row, auth: "logged_in" }])).toMatchObject({
    ready: ["codex"],
    next: { action: "start_thread" },
  });
  expect(onboardingChecklist([{ ...row, installed: false }])).toMatchObject({
    ready: [],
    next: { action: "install", provider: "codex" },
    providers: [{ installCommand: "npm install -g @openai/codex" }],
  });
  expect(onboardingChecklist([{ ...row, installed: null, refreshing: true }])).toMatchObject({
    next: { action: "refresh" },
  });
});

test("expired and exhausted installations stay out of the ready checklist", () => {
  for (const observation of [
    { ...row, auth: "logged_in" as const, error: "Authentication expired" },
    { ...row, auth: "logged_in" as const, readiness: "needs_attention" as const },
  ]) {
    expect(providerReadiness(observation).readiness).toBe("needs_attention");
    expect(onboardingChecklist([observation]).ready).toEqual([]);
  }
  expect(providerReadiness({ ...row, enabled: false }).readiness).toBe("not_configured");
  expect(onboardingChecklist([{ ...row, error: "Authentication expired" }])).toMatchObject({
    next: { action: "sign_in", provider: "codex" },
  });
});

test("a CLI that doesn't report its sign-in is usable, not a problem", () => {
  const unreported = { ...row, auth: "unknown" as const };
  expect(providerReadiness(unreported)).toMatchObject({ readiness: "signed_in", auth: "unknown" });
  expect(onboardingChecklist([unreported])).toMatchObject({
    ready: ["codex"],
    next: { action: "start_thread" },
  });
});

test("Cursor setup recommends SDK sign-in and never falls back to a legacy CLI", () => {
  const sdk: ProviderStatus = {
    ...row,
    provider: "cursor",
    runtime: "cursor-sdk",
    state: "not_configured",
  };
  const cli: ProviderStatus = { ...sdk, runtime: "cli", auth: "logged_in" };
  for (const rows of [
    [cli, sdk],
    [sdk, cli],
  ])
    expect(onboardingChecklist(rows)).toMatchObject({
      ready: [],
      next: { action: "sign_in", provider: "cursor" },
      providers: [
        {
          runtime: "cursor-sdk",
          readiness: "installed_signed_out",
          loginHint: "Sign in to Cursor",
        },
      ],
    });
  expect(onboardingChecklist([{ ...sdk, installed: false }, cli])).toMatchObject({
    ready: [],
    providers: [{ runtime: "cursor-sdk", readiness: "not_configured" }],
  });
  expect(onboardingChecklist([{ ...sdk, state: undefined, auth: "logged_in" }])).toMatchObject({
    ready: ["cursor"],
  });
});

test.each(["opencode", "pi"] as const)(
  "%s readiness follows connected upstreams without inventing entitlement",
  (provider) => {
    expect(
      providerReadiness({
        ...row,
        provider,
        auth: "unknown",
        authEvidence: "credentials_configured",
      }),
    ).toMatchObject({
      readiness: "signed_in",
      auth: "unknown",
      authEvidence: "credentials_configured",
    });
    expect(providerReadiness({ ...row, provider, auth: "logged_out" }).readiness).toBe(
      "installed_signed_out",
    );
  },
);
