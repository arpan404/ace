import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

test("changed files are grouped by thread and the filter narrows them", async () => {
  await harness().open("/more/files");

  const dedupe = await screen.findByRole("region", {
    name: "Dedupe thread events after reconnect",
  });
  expect(within(dedupe).getByText("packages/client/src/subscriptions.ts")).toBeTruthy();
  expect(within(dedupe).getByText("+48")).toBeTruthy();

  await userEvent.type(screen.getByRole("searchbox", { name: "Filter files" }), "refunds");

  await waitFor(() =>
    expect(
      screen.queryByRole("region", { name: "Dedupe thread events after reconnect" }),
    ).toBeNull(),
  );
  const refunds = screen.getByRole("region", { name: "Partial refunds double-count tax" });
  expect(within(refunds).getAllByRole("listitem")).toHaveLength(2);
});

test("downloading a file reads its current contents; a deleted file cannot be downloaded", async () => {
  await harness().open("/more/files");
  await screen.findByRole("region", { name: "Retry budget for app-server restarts" });

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
  await screen.findByRole("region", { name: "Retry budget for app-server restarts" });

  await userEvent.upload(
    screen.getByLabelText("File to upload"),
    new File(["line one\nline two\n"], "notes.md", { type: "text/markdown" }),
  );

  expect(await screen.findByText("Uploaded uploads/notes.md")).toBeTruthy();
  const uploads = await screen.findByRole("region", { name: "Uploaded by you" });
  expect(within(uploads).getByText("uploads/notes.md")).toBeTruthy();
  expect(within(uploads).getByText("ace")).toBeTruthy();
});
