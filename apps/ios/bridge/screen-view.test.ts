import { AgentId, ThreadId, type ScreenState } from "@ace/protocol";
import { expect, test } from "vitest";
import { coworkLine } from "@ace/ui-core/cowork";
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
    ["Safari", coworkLine("working", "Claude")],
    ["TextEdit", "Nobody is in control"],
  ]);
});

test("an agent the phone can't name is said plainly", () => {
  const [session] = phoneScreenSessions(
    [state("com.apple.Safari", { controller: "agent", holder })],
    () => undefined,
  );
  expect(session?.status).toBe(coworkLine("working", "An agent"));
});

test("a window waiting in the machine's sharing dialog says where to choose it; a shared screen is the person's alone", () => {
  const [waiting] = phoneScreenSessions(
    [state("x", { lifecycle: "starting", target: { kind: "chooser" } })],
    () => undefined,
    "studio-linux",
  );
  expect(waiting).toMatchObject({
    app: "Window or screen",
    status: "Waiting for approval on studio-linux — choose the window in the sharing dialog there.",
    awaitingChoice: true,
    stoppable: true,
  });
  const [screen] = phoneScreenSessions(
    [state("x", { target: { kind: "chooser", picked: { source: "display" } } })],
    () => undefined,
  );
  expect(screen).toMatchObject({
    app: "Shared screen",
    viewOnly: false,
    personOnly: true,
    awaitingChoice: false,
  });
});

test("a window on a desktop that shares without input is watch only, with the desktop's reason", () => {
  const reason =
    "KDE's remote control shares the whole desktop rather than the window or screen you pick.";
  const capabilities = {
    version: 2 as const,
    platform: "linux-wayland" as const,
    capture: { windows: true, displays: true, changeDriven: false },
    input: { pointer: false, keyboard: false, scroll: false, text: false },
    uiTree: true,
    semanticActions: [],
    codecs: ["jpeg" as const],
    permissions: { screen: "granted" as const, input: "n/a" as const },
  };
  const sessions = phoneScreenSessions(
    [
      state("org.kde.kcalc", {
        target: { kind: "window", bundleId: "org.kde.kcalc", windowId: 1 },
        capabilities: { ...capabilities, watchOnly: reason },
      }),
      state("org.gnome.Calculator", {
        target: { kind: "chooser", picked: { source: "display" } },
        capabilities,
      }),
    ],
    () => undefined,
  );
  const watched = sessions.find((session) => session.app !== "Shared screen");
  const controlled = sessions.find((session) => session.app === "Shared screen");
  expect(watched).toMatchObject({ viewOnly: true, watchOnlyReason: reason, personOnly: false });
  expect(controlled).toMatchObject({ viewOnly: false, watchOnlyReason: "", personOnly: true });
});

test("an app whose live video can't play says why in one sentence, and nothing once it plays", () => {
  const [stopped] = phoneScreenSessions(
    [
      state("com.apple.Safari", {
        video: { status: "retrying", reason: "ace-media stopped and is starting again" },
      }),
    ],
    () => undefined,
  );
  expect(stopped?.stopped).toBe("ace-media stopped and is starting again.");
  const [playing] = phoneScreenSessions([state("com.apple.Safari")], () => undefined);
  expect(playing?.stopped).toBe("");
});
