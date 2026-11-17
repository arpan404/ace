import { screen, within } from "@testing-library/react";
import { FakeDaemon } from "@ace/fake-daemon";
import { afterEach, expect, test, vi } from "vitest";
import { harness } from "@/test/harness.tsx";

afterEach(() => {
  vi.unstubAllGlobals();
});

const rail = async () => within(await screen.findByRole("navigation", { name: "App" }));
const daemon = (releaseLine?: string) =>
  new FakeDaemon({ clock: () => 1_000, ...(releaseLine ? { releaseLine } : {}) });

test("a browser on a beta daemon says Beta at the sidebar's foot", async () => {
  await harness({ daemon: daemon("beta") }).open("/settings/general");
  expect(await (await rail()).findByText("Beta")).toBeTruthy();
});

test.each([
  ["a stable daemon", "stable"],
  ["a daemon from before release lines", undefined],
])("a browser on %s says nothing", async (_what, line) => {
  await harness({ daemon: daemon(line) }).open("/settings/general");
  await screen.findByText("Terminals open in");
  expect((await rail()).queryByText("Beta")).toBeNull();
});

test("the desktop app says Beta for its own beta build, whatever daemon it is on", async () => {
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
  expect(await (await rail()).findByText("Beta")).toBeTruthy();
});
