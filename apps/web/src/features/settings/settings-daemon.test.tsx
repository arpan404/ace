import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { fakeClient, harness } from "@/test/harness.tsx";

const checked = (name: string) =>
  screen.findByRole("switch", { name }).then((element) => element.getAttribute("aria-checked"));

test("a setting switched off on the page is what the daemon stores", async () => {
  const app = harness();
  await app.open("/settings/general");
  await waitFor(async () => expect(await checked("Settle when the PR merges")).toBe("true"));

  await userEvent.click(await screen.findByRole("switch", { name: "Settle when the PR merges" }));

  await waitFor(() =>
    expect(app.daemon.services.settings.get("threads.settleOnMerge")).toBe(false),
  );
  expect(await checked("Settle when the PR merges")).toBe("false");
});

test("a setting changed from another device shows up without reloading the page", async () => {
  const app = harness();
  await app.open("/settings/general");
  await waitFor(async () => expect(await checked("Settle when the PR merges")).toBe("true"));

  const phone = fakeClient(app.daemon);
  await phone.start();
  await waitFor(() => expect(phone.state).toBe("ready"));
  await phone.request({
    type: "settings.set",
    key: "threads.settleOnMerge",
    value: false,
    layer: { kind: "global" },
  });

  await waitFor(async () => expect(await checked("Settle when the PR merges")).toBe("false"));
});

test("settings read again after the daemon restarts, including changes made while away", async () => {
  const app = harness();
  await app.open("/settings/general");
  await waitFor(async () => expect(await checked("Settle when the PR merges")).toBe("true"));

  app.daemon.disconnectAll();
  const other = fakeClient(app.daemon);
  await other.start();
  await waitFor(() => expect(other.state).toBe("ready"));
  await other.request({
    type: "settings.set",
    key: "threads.settleOnMerge",
    value: false,
    layer: { kind: "global" },
  });

  await waitFor(async () => expect(await checked("Settle when the PR merges")).toBe("false"));
});

test("Reset all settings clears provider choices and native modes along with ordinary preferences", async () => {
  const app = harness();
  await app.client.start();
  await waitFor(() => expect(app.client.state).toBe("ready"));
  for (const [key, value] of [
    ["providers.default", "claude"],
    ["permissions.providerModes", { codex: "never" }],
    ["providers.configuration", []],
    ["threads.useWorktree", false],
  ] as const)
    await app.client.request({
      type: "settings.set",
      key,
      value: key === "providers.configuration" ? [] : value,
      layer: { kind: "global" },
    });
  await app.open("/settings/advanced");
  await userEvent.click(await screen.findByRole("button", { name: /^Reset$/ }));
  const dialog = await screen.findByRole("dialog", { name: "Reset all settings?" });
  await userEvent.click(within(dialog).getByRole("button", { name: /Reset/ }));
  await screen.findByText("Settings reset");
  for (const key of [
    "providers.default",
    "permissions.providerModes",
    "providers.configuration",
    "threads.useWorktree",
  ] as const) {
    const reply = await app.client.request({ type: "settings.get", key, scope: {} });
    expect(reply.entries[0]?.provenance).toBe("defaults");
  }
});

test("Settings does not offer a silence timeout that the engine cannot use", async () => {
  await harness().open("/settings/general");
  await screen.findByRole("switch", { name: "Continue threads after a restart" });
  expect(screen.queryByText("Unresponsive after")).toBeNull();
});
