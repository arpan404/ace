import { screen, within } from "@testing-library/react";
import { FakeDaemon } from "@ace/fake-daemon";
import { afterEach, expect, test, vi } from "vitest";
import { harness } from "@/test/harness.tsx";
import { betaName } from "./beta-peel.tsx";

afterEach(() => {
  vi.unstubAllGlobals();
});

const rail = async () => within(await screen.findByRole("navigation", { name: "App" }));
const daemon = (releaseLine?: string) =>
  new FakeDaemon({ clock: () => 1_000, ...(releaseLine ? { releaseLine } : {}) });

const account = async (name: RegExp = /account/) => (await rail()).findByRole("button", { name });
const peeled = (button: HTMLElement) => button.querySelector('[data-part="beta-peel"]') !== null;

test("a browser on a beta daemon peels the profile disc and names the beta", async () => {
  await harness({ daemon: daemon("beta") }).open("/settings/general");
  const button = await account(/account, ace beta$/);
  expect(peeled(button)).toBe(true);
});

test.each([
  ["a stable daemon", "stable"],
  ["a daemon from before release lines", undefined],
])("a browser on %s leaves the profile disc whole", async (_what, line) => {
  await harness({ daemon: daemon(line) }).open("/settings/general");
  await screen.findByText("Terminals open in");
  const button = await account();
  expect(button.getAttribute("aria-label")).not.toMatch(/beta/i);
  expect(peeled(button)).toBe(false);
});

test("the desktop app peels the disc for its own beta build, named by version, on any daemon", async () => {
  const status = {
    state: "current",
    currentVersion: "1.0.0-beta.1",
    version: null,
    releaseUrl: null,
    inPlace: true,
    percent: null,
    waiting: 0,
    notes: [],
    olderReleases: 0,
    line: "beta",
    buildLine: "beta",
    blocked: null,
    error: null,
  };
  vi.stubGlobal("ace", {
    updates: { current: async () => status, onStatus: () => () => {} },
  });
  await harness({ daemon: daemon("stable") }).open("/settings/general");
  const button = await account(/account, ace 1\.0\.0 beta 1$/);
  expect(peeled(button)).toBe(true);
});

test.each([
  ["0.0.24-beta.1", "ace 0.0.24 beta 1"],
  ["0.0.24-beta.12", "ace 0.0.24 beta 12"],
  ["0.0.24", "ace beta"],
  ["", "ace beta"],
  [undefined, "ace beta"],
])("a beta build %s is named %s", (version, name) => {
  expect(betaName(version)).toBe(name);
});
