import { screen, within } from "@testing-library/react";
import { FakeDaemon } from "@ace/fake-daemon";
import { afterEach, expect, test, vi } from "vitest";
import { harness } from "@/test/harness.tsx";
import { betaName } from "./release-line-mark.tsx";

afterEach(() => {
  vi.unstubAllGlobals();
});

const rail = async () => within(await screen.findByRole("navigation", { name: "App" }));
const daemon = (releaseLine?: string) =>
  new FakeDaemon({ clock: () => 1_000, ...(releaseLine ? { releaseLine } : {}) });

const betaMark = async (name: string | RegExp) => (await rail()).findByRole("link", { name });

test("a browser on a beta daemon shows the beta mark at the sidebar's foot", async () => {
  await harness({ daemon: daemon("beta") }).open("/settings/general");
  expect((await betaMark("ace beta")).getAttribute("href")).toBe("/settings/general");
});

test.each([
  ["a stable daemon", "stable"],
  ["a daemon from before release lines", undefined],
])("a browser on %s shows no beta mark", async (_what, line) => {
  await harness({ daemon: daemon(line) }).open("/settings/general");
  await screen.findByText("Terminals open in");
  expect((await rail()).queryByRole("link", { name: /beta/i })).toBeNull();
});

test("the desktop app marks its own beta build, by version, whatever daemon it is on", async () => {
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
  expect(await betaMark("ace 1.0.0 beta 1")).toBeTruthy();
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
