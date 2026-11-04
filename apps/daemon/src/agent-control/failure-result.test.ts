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
      if (status.state === "limited") {
        expect(result.resetsAt).toBe(5000);
        expect(result.message).toContain("1970-01-01T00:00:05.000Z");
      }
    }
  },
);
