import { expect, test } from "vitest";
import { failureResult } from "./failure-result.ts";
import type { AgentStatus, ThreadStatus } from "@ace/protocol";

test.each([
  {
    name: "quota error",
    status: { state: "failed" },
    agent: { state: "failed", error: { kind: "quota", message: "Allowance exhausted" } },
    expected: "usage_limited",
  },
  {
    name: "stopped limit with reset",
    status: { state: "limited", until: 5000 },
    agent: { state: "blocked", on: "rate_limit", refs: [] },
    expected: "usage_limited",
  },
  {
    name: "process exit",
    status: { state: "failed" },
    agent: { state: "failed", error: { kind: "process_exit", message: "Exit 7" } },
    expected: "provider_failed",
  },
  {
    name: "temporary rate limit",
    status: { state: "failed" },
    agent: {
      state: "failed",
      error: { kind: "provider", code: "rate_limit", message: "Too many requests" },
    },
    expected: "rate_limited",
  },
  { name: "missing provider evidence", status: { state: "failed" }, expected: "provider_failed" },
  {
    name: "live retry",
    status: { state: "waiting", on: "rate_limit" },
    agent: { state: "blocked", on: "rate_limit", refs: [] },
  },
  { name: "success", status: { state: "done" }, agent: { state: "idle" } },
] satisfies { name: string; status: ThreadStatus; agent?: AgentStatus; expected?: string }[])(
  "$name preserves the stop reason without classifying live work as stopped",
  ({ status, agent, expected }) => {
    const result = failureResult({ status }, agent, {
      accountId: "account-a",
      accountLabel: "Primary",
    });
    expect(result?.code).toBe(expected);
    if (result) {
      expect(result.message.length).toBeGreaterThan(0);
      expect(result.accountId).toBe("account-a");
      expect(result.accountLabel).toBe("Primary");
      // Only a used-up allowance reads as a usage limit; a throttle never does.
      expect(result.message.includes("Usage limit")).toBe(expected === "usage_limited");
      if (status.state === "limited") {
        expect(result.resetsAt).toBe(5000);
        expect(result.message).toContain("1970-01-01T00:00:05.000Z");
      }
    }
  },
);

test.each([
  {
    name: "a process exit",
    error: { kind: "process_exit", message: "Exit 7" },
    expected: "provider_failed",
  },
  {
    name: "an auth error",
    error: { kind: "auth", message: "Signed out" },
    expected: "provider_failed",
  },
  {
    name: "a provider error code",
    error: { kind: "provider", code: "overloaded", message: "Overloaded" },
    expected: "provider_failed",
  },
  {
    name: "a vague provider error",
    error: { kind: "provider", message: "Stopped" },
    expected: "usage_limited",
  },
  { name: "no error", error: undefined, expected: "usage_limited" },
] as const)(
  "with a fresh reading of a used-up account, $name reads as $expected",
  ({ error, expected }) => {
    const agent: AgentStatus | undefined = error
      ? { state: "failed", error: { ...error } }
      : undefined;
    const result = failureResult({ status: { state: "failed" } }, agent, {
      accountId: "account-a",
      usageLimited: true,
    });
    expect(result?.code).toBe(expected);
  },
);
