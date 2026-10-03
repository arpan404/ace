import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

const region = (name: string) => screen.findByRole("region", { name });
const rowText = (section: HTMLElement, path: string) =>
  within(section).getByText(path).closest("li")?.textContent ?? "";

test("each thread lists the files its edits touched, counted as its Changes tab counts them", async () => {
  await harness().open("/more/files");

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
  await harness().open("/more/files");
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

test("downloading a file reads its current contents; a deleted file cannot be downloaded", async () => {
  await harness().open("/more/files");
  await region("Retry budget for app-server restarts");

  await userEvent.click(
    screen.getByRole("button", { name: "Download src/supervisor/restart-budget.ts" }),
  );

  expect(await screen.findByText("Downloaded restart-budget.ts")).toBeTruthy();
  expect(
    (screen.getByRole("button", { name: "Download docs/legacy-install.md" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
});

test("uploading a file adds it to the chosen project's files", async () => {
  await harness().open("/more/files");
  await region("Retry budget for app-server restarts");

  await userEvent.click(screen.getByRole("button", { name: "Upload" }));
  await userEvent.click(await screen.findByRole("menuitem", { name: "Upload to relay" }));
  await userEvent.upload(
    screen.getByLabelText("File to upload"),
    new File(["line one\nline two\n"], "notes.md", { type: "text/markdown" }),
  );

  expect(await screen.findByText("Uploaded uploads/notes.md to relay")).toBeTruthy();
  const uploads = await region("Uploaded by you");
  expect(within(uploads).getByText("uploads/notes.md")).toBeTruthy();
  expect(within(uploads).getByText("relay")).toBeTruthy();
});
