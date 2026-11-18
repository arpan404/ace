import { expect, it } from "vitest";
import { appStandingAllowed } from "./app-standing.ts";

const launchedWith =
  (...switches: string[]) =>
  (name: string) =>
    switches.includes(name);

it("a plain launch gives its daemon a key", () => {
  expect(appStandingAllowed(launchedWith())).toBe(true);
});

it.each(["remote-debugging-port", "remote-debugging-pipe"])(
  "a launch another process could drive (--%s) gives none",
  (name) => {
    expect(appStandingAllowed(launchedWith(name))).toBe(false);
  },
);
