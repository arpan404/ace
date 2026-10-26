import { expect, test } from "vitest";
import type { ScreenState } from "@ace/protocol";
import { authorizeInput, type Control } from "./policy.ts";

const control = (
  target: ScreenState["target"],
  controller: ScreenState["controller"],
  owner = "phone",
): Control => ({
  state: {
    sessionId: "s",
    lifecycle: "live",
    controller,
    mode: "background",
    secureInputAllowed: false,
    indicator: true,
    target,
    permissions: { screenRecording: true, accessibility: true },
  },
  epoch: 1,
  owner,
});

test("a screen shared in the machine's sharing dialog takes its person's input and never an agent's", () => {
  const screen = { kind: "chooser", picked: { source: "display" } } as const;
  expect(() => authorizeInput(control(screen, "human"), "human", "phone")).not.toThrow();
  expect(() => authorizeInput(control(screen, "agent", "t:a"), "agent", "t:a")).toThrow(
    /only the person's input/,
  );
  // Another viewer than the one in control is still refused.
  expect(() => authorizeInput(control(screen, "human"), "human", "laptop")).toThrow(/ownership/);
});

test("a shared window takes whoever controls it; a display captured without a dialog takes nobody", () => {
  const window = {
    kind: "chooser",
    picked: { source: "window", bundleId: "org.gnome.Calculator" },
  } as const;
  expect(() => authorizeInput(control(window, "agent", "t:a"), "agent", "t:a")).not.toThrow();
  const display: ScreenState["target"] = { kind: "display", displayId: 1, bundleIds: ["a"] };
  expect(() => authorizeInput(control(display, "human"), "human", "phone")).toThrow(/view-only/);
});
