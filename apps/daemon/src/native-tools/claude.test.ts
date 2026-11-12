import { join } from "node:path";
import { expect, test } from "vitest";
import {
  claudeChromeDefault,
  claudeChromeLaunch,
  claudeConfigPath,
  claudeNativeTools,
} from "./claude.ts";

test.each([
  ["on", undefined, true],
  ["on", false, true],
  ["off", true, false],
  ["off", undefined, false],
  ["auto", true, true],
  ["auto", false, undefined],
  ["auto", undefined, undefined],
] as const)(
  "Claude in Chrome set to %s with Claude's default %s launches with %s",
  (setting, claudeDefault, flag) => {
    expect(claudeChromeLaunch(setting, claudeDefault)).toBe(flag);
  },
);

test.each([
  ["on", undefined, "ready", undefined],
  ["auto", true, "ready", undefined],
  ["auto", undefined, "unavailable", "Off in Claude's settings"],
  ["off", true, "unavailable", "Turned off in ace"],
] as const)(
  "Claude in Chrome set to %s with Claude's default %s reads %s",
  (setting, claudeDefault, state, reason) => {
    expect(claudeNativeTools(setting, claudeDefault)).toEqual([
      { id: "chrome", label: "Claude in Chrome", state, ...(reason ? { reason } : {}) },
    ]);
  },
);

test.each([
  ["turned on", '{"claudeInChromeDefaultEnabled":true}', true],
  ["turned off", '{"claudeInChromeDefaultEnabled":false}', false],
  ["not set", '{"projects":{}}', undefined],
  ["not a boolean", '{"claudeInChromeDefaultEnabled":"yes"}', undefined],
  ["malformed JSON", '{"claudeInChromeDefaultEnabled":', undefined],
  ["not an object", "[true]", undefined],
  ["absent", undefined, undefined],
])("Claude's config with Chrome %s reads as %s", (_, text, expected) => {
  expect(claudeChromeDefault(text)).toBe(expected);
});

test("Claude's config lives in CLAUDE_CONFIG_DIR when set, else the home folder", () => {
  expect(claudeConfigPath({ HOME: "/Users/me", CLAUDE_CONFIG_DIR: "/cfg" })).toBe(
    join("/cfg", ".claude.json"),
  );
  expect(claudeConfigPath({ HOME: "/Users/me" })).toBe(join("/Users/me", ".claude.json"));
  expect(claudeConfigPath({})).toBeUndefined();
});
