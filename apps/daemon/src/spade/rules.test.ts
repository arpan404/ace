import { describe, expect, test } from "vitest";
import {
  checkLivePath,
  checkSpadePath,
  scopeFor,
  spadeStartGraceMs,
  spadeState,
  type SpadeFacts,
} from "./rules.ts";

const facts = (change: Partial<SpadeFacts>): SpadeFacts => ({
  enabled: true,
  service: "running",
  healthy: false,
  silentForMs: 0,
  ...change,
});
describe("spade.status from the service and its files", () => {
  const endpoint = { host: "127.0.0.1", port: 4100, pid: 42, version: "0.4.0", api: 1 } as const;
  test("is off while Spade is turned off, whatever is registered", () => {
    expect(spadeState(facts({ enabled: false, endpoint, healthy: true }))).toEqual({
      state: "off",
    });
  });
  test("is off when no service is registered", () => {
    expect(spadeState(facts({ service: "absent" }))).toMatchObject({ state: "off" });
  });
  test("is ready once the running service's Spade answers /health with a valid proof", () => {
    expect(spadeState(facts({ endpoint, healthy: true, proof: "ok" }))).toEqual({
      state: "ready",
      version: "0.4.0",
    });
  });
  test("is ready and says why while Spade still waits on its setup, with the platform", () => {
    const waiting = facts({
      endpoint,
      healthy: true,
      proof: "ok",
      setup: "waiting for the keychain",
      platform: "darwin",
    });
    expect(spadeState(waiting)).toEqual({
      state: "ready",
      version: "0.4.0",
      setup: { reason: "waiting for the keychain", platform: "darwin" },
    });
    expect(spadeState({ ...waiting, setup: undefined })).toEqual({
      state: "ready",
      version: "0.4.0",
    });
  });
  test.each(["missing", "wrong"] as const)(
    "is failed, never ready, when the listener's proof is %s",
    (proof) => {
      const status = spadeState(facts({ endpoint, healthy: true, proof }));
      expect(status.state).toBe("failed");
      expect(status.state === "failed" && status.reason).toContain("can't prove it is Spade");
    },
  );
  test.each([
    ["absent", "off"],
    ["stopped", "failed"],
  ] as const)(
    "is not ready with the service %s, even with Spade proving itself",
    (service, state) => {
      expect(spadeState(facts({ service, endpoint, healthy: true, proof: "ok" })).state).toBe(
        state,
      );
    },
  );
  test("is starting while the service runs and Spade hasn't answered yet", () => {
    expect(spadeState(facts({ silentForMs: spadeStartGraceMs - 1 }))).toEqual({
      state: "starting",
    });
    expect(spadeState(facts({ service: "absent", installing: true }))).toEqual({
      state: "starting",
    });
  });
  test.each<[string, Partial<SpadeFacts>, string]>([
    ["stays silent", { endpoint, silentForMs: spadeStartGraceMs }, "isn't answering"],
    ["never listens", { silentForMs: spadeStartGraceMs }, "hasn't started listening"],
    ["is stopped", { service: "stopped" }, "not running"],
    ["can't be read", { service: { error: "launchctl failed" } }, "launchctl failed"],
    ["couldn't be registered", { problem: "No spade-server in this release." }, "No spade-server"],
  ])("is failed with the reason when the service %s", (_name, change, words) => {
    const status = spadeState(facts(change));
    expect(status.state).toBe("failed");
    expect(status.state === "failed" && status.reason).toContain(words);
  });
});

describe("paths clients may reach", () => {
  test.each([
    "/v1/conversations",
    "/v1/conversations/abc/events?after=12",
    "/v1/conversations/abc%20def/messages",
  ])("forwards %s", (path) => {
    expect(checkSpadePath(path)).toEqual({ ok: true, path });
  });
  test.each([
    ["the health check", "/health"],
    ["another API version", "/v2/conversations"],
    ["a dot segment", "/v1/../health"],
    ["an encoded dot segment", "/v1/%2e%2e/health"],
    ["an encoded slash", "/v1/a%2Fb"],
    ["an empty segment", "/v1//conversations"],
    ["a fragment", "/v1/conversations#x"],
    ["a full URL", "http://127.0.0.1:1/v1/x"],
    ["a backslash", "/v1/a\\b"],
    ["whitespace", "/v1/a b"],
    ["a broken escape", "/v1/a%zz"],
  ])("refuses %s", (_name, path) => {
    expect(checkSpadePath(path).ok).toBe(false);
  });
  test("live streams are /live paths only", () => {
    expect(checkLivePath("/v1/conversations/c1/live?after=3").ok).toBe(true);
    expect(checkLivePath("/v1/conversations/c1/events").ok).toBe(false);
    expect(checkLivePath("/v1/../live").ok).toBe(false);
  });
});

test("reading Spade needs the read scope; changing it needs operate", () => {
  expect(scopeFor("GET")).toBe("read");
  for (const method of ["POST", "PUT", "PATCH", "DELETE"] as const)
    expect(scopeFor(method)).toBe("operate");
});
