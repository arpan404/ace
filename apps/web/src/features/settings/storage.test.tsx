import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

test("storage shows protected data and waits for confirmation before removing reviewed bytes", async () => {
  const app = harness({ clock: () => 200 * 86400000 });
  app.daemon.seedServices({
    storageItems: [
      {
        id: "old-log",
        kind: "logs",
        label: "logs/ace.1.jsonl",
        bytes: 1024,
        modifiedAt: 1,
        threadIds: [],
        fingerprint: "old",
        protections: [],
        eligibleReason: "expired",
      },
      {
        id: "live-log",
        kind: "logs",
        label: "logs/ace.jsonl",
        bytes: 2048,
        modifiedAt: 1,
        threadIds: [],
        fingerprint: "live",
        protections: ["leased"],
        eligibleReason: "expired",
      },
    ],
  });
  await app.open("/settings/storage");
  await userEvent.click(await screen.findByRole("button", { name: "Preview cleanup" }));
  const list = await screen.findByRole("list", { name: "Cleanup items" });
  expect(within(list).getByText("Keep · Currently in use")).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "Remove 1 items" }));
  const dialog = await screen.findByRole("dialog");
  await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
  expect(within(list).queryByText("Removed")).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "Remove 1 items" }));
  await userEvent.click(
    within(await screen.findByRole("dialog")).getByRole("button", { name: "Remove items" }),
  );
  expect(await within(list).findByText("Removed")).toBeTruthy();
  expect(screen.getByText("Cleanup finished. Items that became protected were kept.")).toBeTruthy();
});

test("compacting the database reports the result and refreshes usage", async () => {
  const app = harness({ clock: () => 200 * 86400000 });
  await app.open("/settings/storage");
  await userEvent.click(await screen.findByRole("button", { name: "Compact database" }));
  expect(await screen.findByText("Compacted from 0 B to 0 B.")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Rebuild database" })).toBeNull();
});
