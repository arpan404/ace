import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, onTestFinished, test, vi } from "vitest";
import { ScenarioPlayer, devWorld, facts } from "@ace/fake-daemon";
import { harness } from "@/test/harness.tsx";

/** More › Files over the development world's threads, read from the daemon. */
async function openFiles() {
  const app = harness();
  for (const thread of devWorld()) {
    const player = new ScenarioPlayer(app.daemon, thread.scenario, { agoMs: thread.agoMs });
    if (thread.through) player.runThrough(thread.through);
    else player.runUntilBlocked();
  }
  await app.open("/more/files");
  return app;
}

const region = (name: string) => screen.findByRole("region", { name });

afterEach(() => vi.useRealTimers());

/** The blob the page hands the browser to save, read back as text. */
function captureDownloads() {
  const saved: Blob[] = [];
  const create = URL.createObjectURL;
  const revoke = URL.revokeObjectURL;
  URL.createObjectURL = (blob: Blob) => {
    saved.push(blob);
    return "blob:test";
  };
  URL.revokeObjectURL = () => {};
  return {
    text: async () => (await saved.at(-1)?.text()) ?? "",
    restore: () => {
      URL.createObjectURL = create;
      URL.revokeObjectURL = revoke;
    },
  };
}
const rowText = (section: HTMLElement, path: string) =>
  within(section).getByText(path).closest("li")?.textContent ?? "";

test("each thread lists the files its edits touched, counted as its Changes tab counts them", async () => {
  await openFiles();

  const dedupe = await region("Dedupe thread events after reconnect");
  // The hero thread's two edits: together they are its "2 changed files +30 −7".
  await waitFor(() => expect(rowText(dedupe, "apps/daemon/src/replay-session.ts")).toMatch(/\+\d/));
  const rows = ["apps/daemon/src/replay-session.ts", "apps/web/src/relay/outbox.ts"].map(
    (path) => within(dedupe).getByText(path).closest("li") as HTMLElement,
  );
  const sum = (pattern: RegExp) =>
    rows.reduce(
      (total, row) => total + Number(within(row).queryByText(pattern)?.textContent?.slice(1) ?? 0),
      0,
    );
  expect([sum(/^\+\d+$/), sum(/^−\d+$/)]).toEqual([30, 7]);

  const refunds = await region("Partial refunds double-count tax");
  expect(rowText(refunds, "src/refunds/tax.test.ts")).toContain("added");
  expect(rowText(refunds, "src/refunds/tax.ts")).toContain("modified");
});

test("the project picker and the path filter narrow the list", async () => {
  await openFiles();
  await region("Dedupe thread events after reconnect");

  await userEvent.click(screen.getByRole("combobox", { name: "Project" }));
  await userEvent.click(await screen.findByRole("option", { name: "billing-api" }));

  await waitFor(() =>
    expect(
      screen.queryByRole("region", { name: "Dedupe thread events after reconnect" }),
    ).toBeNull(),
  );
  expect(screen.queryByRole("region", { name: "Retry budget for app-server restarts" })).toBeNull();
  expect(await region("Partial refunds double-count tax")).toBeTruthy();

  await userEvent.type(screen.getByRole("searchbox", { name: "Filter files" }), "test");
  const refunds = await region("Partial refunds double-count tax");
  await waitFor(() => expect(within(refunds).getAllByRole("listitem")).toHaveLength(1));
});

test("any file that still exists downloads; a deleted one says why it can't", async () => {
  const downloads = captureDownloads();
  onTestFinished(downloads.restore);
  await openFiles();
  const refunds = await region("Partial refunds double-count tax");
  await userEvent.click(
    within(refunds).getByRole("button", { name: "Download src/refunds/tax.test.ts" }),
  );
  expect(await screen.findByText("Downloaded tax.test.ts")).toBeTruthy();
  // A file the agent wrote whole downloads as it wrote it.
  expect(await downloads.text()).toContain("describe");

  // An edited file comes from the thread's checkout, as it is now.
  const dedupe = await region("Dedupe thread events after reconnect");
  await userEvent.click(
    within(dedupe).getByRole("button", { name: "Download apps/web/src/relay/outbox.ts" }),
  );
  expect(await screen.findByText("Downloaded outbox.ts")).toBeTruthy();
  expect(await downloads.text()).toContain("export class Outbox");

  const deleted = screen.getByRole("button", { name: "Download docs/legacy-install.md" });
  expect((deleted as HTMLButtonElement).disabled).toBe(true);
  await userEvent.hover(deleted.parentElement ?? deleted);
  expect(await screen.findByText("Deleted in this thread")).toBeTruthy();
});

test("each file opens its thread, and More › Files offers no upload the daemon can't take", async () => {
  await openFiles();
  const refunds = await region("Partial refunds double-count tax");
  expect(screen.queryByRole("button", { name: /^Upload/ })).toBeNull();
  await userEvent.click(within(refunds).getByRole("link", { name: "src/refunds/tax.ts" }));
  expect(
    await screen.findByRole("heading", { level: 1, name: /Partial refunds double-count tax/ }),
  ).toBeTruthy();
});

test("an edit an agent makes while the page is open shows on the next read", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const app = await openFiles();
  const dedupe = await region("Dedupe thread events after reconnect");
  expect(within(dedupe).queryByText("docs/replay.md")).toBeNull();

  app.daemon.apply("thread-dedupe", [
    facts.tool("root", "live-edit", {
      kind: "file.edit",
      title: "Edit docs/replay.md",
      detail: {
        kind: "file.edit",
        changes: [{ path: "docs/replay.md", kind: "update", diff: "@@ -1 +1 @@\n-old\n+new\n" }],
      },
    }),
    facts.toolDone("root", "live-edit"),
  ]);
  await vi.advanceTimersByTimeAsync(30_000);

  expect(
    await within(await region("Dedupe thread events after reconnect")).findByText("docs/replay.md"),
  ).toBeTruthy();
  // The list stayed on screen while it read again.
  expect(screen.queryByRole("status", { name: "Loading files" })).toBeNull();
});

test("a filter that matches nothing says so and can be cleared", async () => {
  await openFiles();
  await region("Dedupe thread events after reconnect");
  await userEvent.type(screen.getByRole("searchbox", { name: "Filter files" }), "zzz");
  expect(await screen.findByText('No files match "zzz".')).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "Clear filter" }));
  expect(await region("Dedupe thread events after reconnect")).toBeTruthy();
});

test("when the daemon can't read the files, the page says so in words and tries again", async () => {
  const app = harness();
  for (const thread of devWorld().slice(0, 3)) {
    const player = new ScenarioPlayer(app.daemon, thread.scenario, { agoMs: thread.agoMs });
    if (thread.through) player.runThrough(thread.through);
    else player.runUntilBlocked();
  }
  app.daemon.failRequests("items.page");
  await app.open("/more/files");
  expect(await screen.findByText("Files unavailable", {}, { timeout: 4000 })).toBeTruthy();
  expect(screen.queryByText("unavailable")).toBeNull();
  app.daemon.restoreRequests();
  await userEvent.click(screen.getByRole("button", { name: "Try again" }));
  await waitFor(() => expect(screen.queryByText("Files unavailable")).toBeNull());
});
