import { AgentId, ThreadId, type ScreenState } from "@ace/protocol";
import { expect, test } from "vitest";
import { phoneScreenSessions } from "./screen-view.ts";

const state = (bundleId: string, extra: Partial<ScreenState> = {}): ScreenState => ({
  sessionId: `s-${bundleId.replaceAll(".", "-")}`,
  lifecycle: "live",
  controller: "none",
  mode: "background",
  secureInputAllowed: false,
  indicator: false,
  target: { kind: "app", bundleId },
  permissions: { screenRecording: true, accessibility: true },
  ...extra,
});
const holder = { threadId: ThreadId.parse("thread-1"), agentId: AgentId.parse("root") };

test("apps an agent holds come first and name the agent; stopped ones leave the list", () => {
  const sessions = phoneScreenSessions(
    [
      state("com.apple.TextEdit"),
      state("com.apple.Safari", { controller: "agent", holder }),
      state("com.apple.Notes", { lifecycle: "stopped" }),
    ],
    (who) => (who.agentId === "root" ? "Claude" : undefined),
  );

  expect(sessions.map((session) => [session.app, session.status])).toEqual([
    ["Safari", "Claude is in control"],
    ["TextEdit", "Nobody is in control"],
  ]);
});

test("an agent the phone can't name is said plainly", () => {
  const [session] = phoneScreenSessions(
    [state("com.apple.Safari", { controller: "agent", holder })],
    () => undefined,
  );
  expect(session?.status).toBe("An agent is in control");
});
