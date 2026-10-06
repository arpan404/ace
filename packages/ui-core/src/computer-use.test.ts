import type { ScreenState } from "@ace/protocol";
import { expect, test } from "vitest";
import {
  agentSessions,
  grantRows,
  indicatorSessions,
  screenProblem,
  screenSession,
  visibleSessions,
} from "./computer-use.ts";

const state = (overrides: Partial<ScreenState> & { bundleId?: string } = {}): ScreenState => {
  const { bundleId = "com.apple.TextEdit", ...rest } = overrides;
  return {
    sessionId: `s-${bundleId}`,
    lifecycle: "live",
    controller: "none",
    mode: "background",
    secureInputAllowed: false,
    indicator: false,
    target: { kind: "app", bundleId },
    permissions: { screenRecording: true, accessibility: true },
    ...rest,
  };
};

test("an agent's session names the agent, its background mode and whether pixels are captured", () => {
  const view = screenSession(
    state({ controller: "agent", holder: { threadId: "t1", agentId: "a1" }, indicator: true }),
    (holder) => (holder.agentId === "a1" ? "Codex" : "?"),
  );

  expect(view.app).toBe("TextEdit");
  expect(view.status).toBe("Codex is in control");
  expect(view.mode).toBe("In the background");
  expect(view.capturing).toBe(true);
  expect(view.tone).toBe("working");
});

test("a failed session still capturing stays stoppable and says so", () => {
  const view = screenSession(state({ lifecycle: "failed", indicator: true }));

  expect(view.status).toBe("Failed · may still be capturing");
  expect(view.stoppable).toBe(true);
  expect(screenSession(state({ lifecycle: "failed" })).stoppable).toBe(false);
});

test("stopped sessions leave the list and agent-held ones lead it", () => {
  const sessions = visibleSessions([
    state({ bundleId: "com.apple.calculator" }),
    state({ bundleId: "com.apple.Notes", lifecycle: "stopped", controller: "agent" }),
    state({ bundleId: "com.apple.TextEdit", controller: "agent" }),
  ]);

  expect(sessions.map((entry) => entry.sessionId)).toEqual([
    "s-com.apple.TextEdit",
    "s-com.apple.calculator",
  ]);
});

test("the indicator counts agent sessions even without capture", () => {
  expect(
    agentSessions([
      state({ controller: "agent", indicator: false }),
      state({ bundleId: "com.apple.calculator", controller: "human", indicator: true }),
    ]),
  ).toHaveLength(1);
});

test("grants read by app with the widest scope first, sensitive apps marked", () => {
  const rows = grantRows([
    { bundleId: "com.apple.TextEdit", scope: "turn", threadId: "t1", turnId: "u1", grantedAt: 3 },
    { bundleId: "com.apple.systempreferences", scope: "always", grantedAt: 1 },
    { bundleId: "com.apple.TextEdit", scope: "always", grantedAt: 2 },
  ]);

  expect(
    rows.map((row) => `${row.app} · ${row.scopeLabel}${row.sensitive ? " · asks" : ""}`),
  ).toEqual(["System Settings · Always · asks", "TextEdit · Always", "TextEdit · This turn"]);
});

test("a busy target names who holds it and offers taking over, never stealing it", () => {
  const problem = screenProblem("target_busy", "Target held", "Claude");

  expect(problem.title).toBe("Claude is already using this app");
  expect(problem.hint).toMatch(/Take it over first/);
  expect(screenProblem(undefined, "Something broke").title).toBe("Something broke");
});

test("the indicator keeps a session that is stopping or failed while capture is still on", () => {
  const shown = indicatorSessions([
    state({
      bundleId: "com.apple.TextEdit",
      lifecycle: "stopping",
      controller: "none",
      indicator: true,
    }),
    state({
      bundleId: "com.apple.calculator",
      lifecycle: "failed",
      controller: "none",
      indicator: true,
    }),
    state({
      bundleId: "com.apple.Notes",
      lifecycle: "stopped",
      controller: "none",
      indicator: false,
    }),
  ]);

  expect(shown.map((entry) => entry.sessionId)).toEqual([
    "s-com.apple.TextEdit",
    "s-com.apple.calculator",
  ]);
});
