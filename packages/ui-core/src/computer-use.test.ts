import type { ScreenState } from "@ace/protocol";
import { expect, test } from "vitest";
import {
  screenProblem,
  chooserFailure,
  screenSession,
  visibleSessions,
  requirementStatus,
  requirementPermission,
  permissionsReading,
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

test("a busy target names who holds it and offers taking over, never stealing it", () => {
  const problem = screenProblem("target_busy", "Target held", "Claude");

  expect(problem.title).toBe("Claude is already using this app");
  expect(problem.hint).toMatch(/Take it over first/);
  expect(screenProblem(undefined, "Something broke").title).toBe("Something broke");
});

test("live sessions keep one that is stopping or failed while capture is still on", () => {
  const shown = visibleSessions([
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

test("human takeover stays a live session and says who is in control", () => {
  const human = state({ controller: "human", indicator: false });
  expect(screenSession(human).status).toBe("You're in control");
  expect(visibleSessions([human]).map((entry) => entry.sessionId)).toEqual([human.sessionId]);
});

test.each([
  ["ready", "Ready", true],
  ["granted", "Ready", true],
  ["n/a", "Ready", true],
  ["prompt", "Needs your approval", false],
  ["blocked", "Needs attention", false],
  ["denied", "Needs attention", false],
  ["future", "Not checked", false],
])("requirement state %s is shown without assuming a grant", (requirementState, label, ready) => {
  expect(requirementStatus(String(requirementState))).toEqual({ label, ready });
});

test.each(["linux", "win32"])(
  "permission failures for %s offer host requirements without macOS settings",
  (platform) => {
    const problem = screenProblem("permission_denied", "Host access denied", undefined, platform);
    expect(problem.title).not.toContain("macOS");
    expect(problem.hint).toContain("Check the requirements");
  },
);

test("macOS permission failures retain the privacy settings instructions", () => {
  expect(screenProblem("permission_denied", "Denied", undefined, "darwin")).toEqual({
    title: "macOS hasn't granted a permission",
    hint: "Grant Screen Recording and Accessibility to Ace Screen Helper, then try again.",
  });
});

test("older macOS replies retain permission guidance when platform is omitted", () => {
  expect(screenProblem("permission_denied", "Denied").hint).toContain(
    "Screen Recording and Accessibility",
  );
});
test.each(["darwin", "linux", "win32"])("%s recovery instructions name the host", (platform) => {
  const forbidden = screenProblem("forbidden", "Denied", undefined, platform);
  const reading = permissionsReading({
    connected: true,
    closed: false,
    enabled: true,
    permissions: { screenRecording: true, accessibility: true, platform },
    problem: { code: "not_supported", message: "Unavailable" },
  });
  expect(forbidden.hint?.includes("Mac")).toBe(platform === "darwin");
  expect(reading.state).toBe("unavailable");
  if (reading.state === "unavailable")
    expect(reading.next.includes("Mac")).toBe(platform === "darwin");
});
test.each(["ready", "granted", "n/a", "not-applicable"])(
  "%s requirements offer no request action",
  (stateName) => {
    expect(
      requirementPermission({ state: stateName, permission: "accessibility" }),
    ).toBeUndefined();
  },
);
test("unknown permission names remain readable without offering an unsupported request", () => {
  expect(
    requirementPermission({ state: "blocked", permission: "inputMonitoring" }),
  ).toBeUndefined();
  expect(requirementPermission({ state: "blocked", permission: "accessibility" })).toBe(
    "accessibility",
  );
});

test.each([
  ["linux", "permission_denied", "Linux desktop access needs attention"],
  ["win32", "permission_denied", "Windows desktop access needs attention"],
  ["linux", "forbidden", "Use the computer running ace."],
  ["win32", "forbidden", "Use the computer running ace."],
])("%s chooser failure %s keeps the host's guidance", (platform, code, expected) => {
  const sentence = chooserFailure(code, "Host refused sharing", platform);
  expect(sentence).toContain(expected);
  expect(sentence).not.toMatch(/macOS|Screen Recording|Accessibility|Use the Mac/);
});
test("chooser declines and legacy macOS guidance retain their existing words", () => {
  expect(chooserFailure("denied", "Sharing was declined.", "linux")).toBe("Sharing was declined.");
  expect(chooserFailure("permission_denied", "Denied")).toContain(
    "Grant Screen Recording and Accessibility",
  );
});
