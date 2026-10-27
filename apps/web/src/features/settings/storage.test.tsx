import { screen, within, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

test("storage scans through the browser worker client", async () => {
  const app = harness({ throughWorker: true });
  app.daemon.seedServices({ storageDatabase: { bytes: 1234567, reclaimable: 0 } });
  await app.open("/settings/storage");
  expect(await screen.findByText("1.2 MB")).toBeTruthy();
  expect(
    await screen.findByRole("spinbutton", { name: "Worktrees retention days" }),
  ).toHaveProperty("value", "30");
});

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
  await userEvent.click(screen.getByRole("button", { name: "Remove 1 item" }));
  const dialog = await screen.findByRole("dialog");
  await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
  expect(within(list).queryByText("Removed")).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "Remove 1 item" }));
  await userEvent.click(
    within(await screen.findByRole("dialog")).getByRole("button", { name: "Remove items" }),
  );
  expect(await within(list).findByText("Removed")).toBeTruthy();
  expect(screen.getByText("Cleanup finished. Items that became protected were kept.")).toBeTruthy();
});

test("compacting the database reports the freed bytes and refreshes usage", async () => {
  const app = harness({ clock: () => 200 * 86400000 });
  app.daemon.seedServices({
    storageDatabase: { bytes: 10 * 1024 ** 2, reclaimable: 4 * 1024 ** 2 },
  });
  await app.open("/settings/storage");
  expect(await screen.findByText("10.0 MB")).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "Compact database" }));
  expect(await screen.findByText("Compacted from 10.0 MB to 6.0 MB.")).toBeTruthy();
  expect(await screen.findByText("6.0 MB")).toBeTruthy();
  expect(screen.getByText("0 B can be reclaimed by compacting.")).toBeTruthy();
});

test("worktree settings and storage usage belong to the selected daemon", async () => {
  const app = harness({
    throughWorker: true,
    machines: [{ hostId: "build", name: "Build server" }],
  });
  const remote = app.machines.get("build");
  if (!remote) throw new Error("Missing build server");
  app.daemon.seedServices({ storageDatabase: { bytes: 2 * 1024 ** 2, reclaimable: 0 } });
  remote.seedServices({ storageDatabase: { bytes: 3 * 1024 ** 2, reclaimable: 0 } });
  await app.open("/settings/storage");
  expect(await screen.findByText("2.0 MB")).toBeTruthy();
  await waitFor(() => expect(app.pool().machine("build")?.status).toBe("online"));
  await userEvent.click(await screen.findByRole("button", { name: /^Environment: / }));
  await userEvent.click(await screen.findByRole("menuitemradio", { name: /Build server$/ }));
  expect(await screen.findByText("3.0 MB")).toBeTruthy();
  await userEvent.click(await screen.findByRole("switch", { name: "Automatic worktree deletion" }));
  await waitFor(() =>
    expect(remote.services.settings.get("storage.worktreeRetentionDays")).toBe(30),
  );
  const days = screen.getByRole("spinbutton", { name: "Days after settling" });
  await userEvent.clear(days);
  await userEvent.type(days, "7{Enter}");
  await waitFor(() =>
    expect(remote.services.settings.get("storage.worktreeRetentionDays")).toBe(7),
  );
  await userEvent.click(screen.getByRole("switch", { name: "Back up worktrees to origin" }));
  await waitFor(() => expect(remote.services.settings.get("storage.backupWorktrees")).toBe(true));
  expect(app.daemon.services.settings.get("storage.worktreeRetentionDays")).toBeNull();
  expect(app.daemon.services.settings.get("storage.backupWorktrees")).toBe(false);
});

test("delete all settled worktrees previews recent checkouts without deleting other stored data", async () => {
  const now = 200 * 86400000;
  const app = harness({ clock: () => now });
  app.daemon.seedServices({
    storageItems: [
      {
        id: "recent-tree",
        kind: "worktrees",
        label: "worktrees/recent",
        bytes: 4096,
        modifiedAt: now,
        settledAt: now,
        fingerprint: "tree",
        threadIds: [],
        protections: [],
        eligibleReason: "task_finished",
      },
      {
        id: "log",
        kind: "logs",
        label: "logs/old",
        bytes: 512,
        modifiedAt: 1,
        fingerprint: "log",
        threadIds: [],
        protections: [],
        eligibleReason: "expired",
      },
    ],
  });
  await app.open("/settings/storage");
  await userEvent.click(
    await screen.findByRole("button", { name: "Delete all settled worktrees" }),
  );
  const list = await screen.findByRole("list", { name: "Cleanup items" });
  expect(within(list).getByText("worktrees/recent")).toBeTruthy();
  expect(within(list).queryByText("logs/old")).toBeNull();
  expect(within(list).queryByText("Removed")).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "Remove 1 item" }));
  await userEvent.click(
    within(await screen.findByRole("dialog")).getByRole("button", { name: "Remove items" }),
  );
  expect(await within(list).findByText("Removed")).toBeTruthy();
});

test("forcing one worktree keeps the delete-all preview scoped to worktrees and preserves pins", async () => {
  const now = 200 * 86400000;
  const app = harness({ clock: () => now, throughWorker: true });
  app.daemon.seedServices({
    storageItems: [
      {
        id: "dirty-tree",
        kind: "worktrees",
        label: "worktrees/dirty",
        bytes: 4096,
        modifiedAt: now,
        settledAt: now,
        fingerprint: "dirty",
        threadIds: [],
        protections: ["uncommitted", "unpushed"],
        eligibleReason: "task_finished",
      },
      {
        id: "pinned-tree",
        kind: "worktrees",
        label: "worktrees/pinned",
        bytes: 4096,
        modifiedAt: now,
        settledAt: now,
        fingerprint: "pinned",
        threadIds: [],
        protections: ["pinned"],
        eligibleReason: "task_finished",
      },
      {
        id: "old-log",
        kind: "logs",
        label: "logs/old",
        bytes: 512,
        modifiedAt: 1,
        fingerprint: "log",
        threadIds: [],
        protections: [],
        eligibleReason: "expired",
      },
    ],
  });
  await app.open("/settings/storage");
  await userEvent.click(
    await screen.findByRole("button", { name: "Delete all settled worktrees" }),
  );
  const list = await screen.findByRole("list", { name: "Cleanup items" });
  expect(within(list).getAllByRole("checkbox")).toHaveLength(1);
  await userEvent.click(within(list).getByRole("checkbox"));
  await userEvent.click(screen.getByRole("button", { name: "Preview selected force removals" }));
  await within(list).findByText(/Forced for this item/);
  expect(within(list).queryByText("logs/old")).toBeNull();
  expect(within(list).getByText("Keep · Pinned thread")).toBeTruthy();
  expect(within(list).queryByText("Removed")).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "Remove 1 item" }));
  const dialog = await screen.findByRole("dialog");
  await waitFor(() =>
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toBe(document.activeElement),
  );
  await userEvent.click(within(dialog).getByRole("button", { name: "Remove items" }));
  expect(await within(list).findByText("Removed")).toBeTruthy();
  expect(within(list).getByText("Keep · Pinned thread")).toBeTruthy();
});
