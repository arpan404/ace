import type { FakeSpadeApi } from "@ace/fake-daemon";
import { configure, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";
import { spadeApp, withEndpoint } from "@/test/spade.ts";

configure({ asyncUtilTimeout: 10_000 });
beforeEach(() => localStorage.clear());

const garden = (api: FakeSpadeApi) => {
  withEndpoint(api);
  api.addAgent({ id: "main", kind: "main", name: "Spade", avatar: { kind: "spade" } });
  return api.addAgent({ id: "garden", name: "Garden" });
};

test("while Spade waits for the keychain, its panel says what to look for", async () => {
  await spadeApp("/spade", (api) => {
    garden(api);
    api.setStatus({
      state: "ready",
      version: "0.6.0",
      setup: { reason: "waiting for the keychain", platform: "darwin" },
    });
  });
  const line = await screen.findByText(
    "Spade is waiting for the keychain. Look for a macOS prompt and choose Always Allow.",
  );
  expect(line.closest("[role=status]")).not.toBeNull();
  // Spade still runs: its bots stay listed and nothing offers to turn it on.
  expect(await screen.findByRole("navigation", { name: "Bots" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Turn on" })).toBeNull();
});

test("a running Spade with nothing to wait on shows no state line in its panel", async () => {
  await spadeApp("/spade", garden);
  await screen.findByRole("navigation", { name: "Bots" });
  expect(screen.queryByText(/waiting for the keychain/)).toBeNull();
});

test("while the setting loads, Run Spade shows neither on nor off, and spending holds its place", async () => {
  await spadeApp("/settings/spade", garden, {
    daemon: (daemon) => daemon.holdRequests("settings.subscribe"),
  });
  const row = (await screen.findByText("Run Spade on this machine")).closest("[data-setting-slot]");
  if (!(row instanceof HTMLElement)) throw new Error("no Run Spade row");
  // Its place is held by a placeholder, never an off switch that may be on.
  expect(within(row).queryByRole("switch")).toBeNull();
  expect(screen.getByRole("region", { name: "Spending, every bot together" })).toBeTruthy();
});
