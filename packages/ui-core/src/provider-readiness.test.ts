import type { ProviderStatus } from "@ace/protocol";
import { expect, test } from "vitest";
import { readinessView } from "./provider-readiness.ts";

const row = (fields: Partial<ProviderStatus>): ProviderStatus => ({
  provider: "codex",
  runtime: "cli",
  installed: true,
  auth: "logged_in",
  loginHint: "",
  stale: false,
  refreshing: false,
  ...fields,
});

const listed = { models: true, connected: 0 };

test("a signed-in CLI reads as who it's signed in as, and asks for nothing", () => {
  const view = readinessView(row({ accountLabel: "ada@example.com" }), listed);
  expect([view.summary, view.tone, view.primary]).toEqual([
    "Signed in as ada@example.com",
    "ready",
    undefined,
  ]);
});

test("a CLI that doesn't report its sign-in is checked, then ready once it lists models", () => {
  const unknown = row({ auth: "unknown" });
  expect(readinessView(unknown).summary).toBe("Checking…");
  expect(readinessView(unknown, listed)).toMatchObject({ summary: "Ready", unreported: true });
  const silent = readinessView(unknown, { models: false, connected: 0 });
  expect([silent.summary, silent.ready, silent.primary]).toEqual(["Installed", false, undefined]);
});

test("an expired sign-in the catalog reports needs attention, with Reconnect", () => {
  const view = readinessView(row({}), { ...listed, problem: "Cursor sign-in has expired." });
  expect(view).toMatchObject({
    summary: "Needs attention",
    detail: "Cursor sign-in has expired.",
    tone: "problem",
    primary: "reconnect",
  });
});

test("OpenCode is as ready as its services: counted while one is connected, else Sign in", () => {
  const opencode = row({ provider: "opencode", auth: "unknown" });
  expect(readinessView(opencode, { models: true, connected: 1 }).summary).toBe(
    "1 service connected",
  );
  expect(readinessView(opencode, { models: true, connected: 4 }).summary).toBe(
    "4 services connected",
  );
  expect(readinessView(opencode, { models: false, connected: 0 })).toMatchObject({
    summary: "Sign in needed",
    tone: "action",
    primary: "sign_in",
    upstreams: true,
  });
});

test("a missing or switched-off provider is quiet and offers no sign-in", () => {
  const missing = readinessView(row({ installed: false }));
  expect([missing.summary, missing.tone, missing.primary]).toEqual([
    "Not installed",
    "idle",
    undefined,
  ]);
  const off = readinessView(row({ enabled: false, readiness: "not_configured" }));
  expect([off.summary, off.primary]).toEqual(["Turned off", undefined]);
});
