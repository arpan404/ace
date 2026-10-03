import { screen, waitFor } from "@testing-library/react";
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
