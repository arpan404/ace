import { expect, test } from "vitest";
import { gateView, type GateFacts } from "./window-machine.ts";

/** A fresh window: nothing stored, nothing handed over, nothing tried. */
const fresh: GateFacts = {
  opened: false,
  status: { kind: "editing" },
  hasTarget: false,
  editing: false,
  handoff: false,
  pairingLink: false,
  shown: true,
  desktop: false,
  handed: false,
  canRunEmpty: true,
};

test.each<[string, Partial<GateFacts>, ReturnType<typeof gateView>]>([
  ["a fresh window opens the app with no machine", {}, "no-machine"],
  [
    "a desktop with no daemon of its own opens the app with no machine",
    { desktop: true },
    "no-machine",
  ],
  ["a build that can't run empty keeps the connection screen", { canRunEmpty: false }, "connect"],
  [
    "a refused machine is said on the connection screen",
    { status: { kind: "editing", problem: "auth" } },
    "connect",
  ],
  ["the address form the person asked for stays", { editing: true }, "connect"],
  ["a link waiting for an answer asks first", { handoff: true }, "connect"],
  ["a pairing link opens the pairing form", { pairingLink: true }, "connect"],
  [
    "a machine being tried is never shown as no machine",
    { hasTarget: true, status: { kind: "connecting" } },
    "connect",
  ],
  [
    "a stored machine connects behind the startup screen",
    { hasTarget: true, shown: false, status: { kind: "connecting" } },
    "splash",
  ],
  [
    "an unreachable stored machine is said, not hidden",
    { hasTarget: true, shown: false, status: { kind: "unreachable", offline: false } },
    "connect",
  ],
  [
    "the desktop's own daemon reconnecting stays behind the startup screen",
    {
      hasTarget: true,
      shown: false,
      desktop: true,
      handed: true,
      status: { kind: "unreachable", offline: false },
    },
    "splash",
  ],
  [
    "a daemon that is starting says so",
    { hasTarget: true, status: { kind: "starting" } },
    "starting",
  ],
  [
    "an opened machine shows the app",
    { hasTarget: true, opened: true, status: { kind: "ready" } },
    "app",
  ],
])("%s", (_name, facts, view) => {
  expect(gateView({ ...fresh, ...facts })).toBe(view);
});
