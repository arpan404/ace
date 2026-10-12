import { beforeEach, expect, test } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ForgeLifecycleSnapshot, type ForgeLifecycleAction } from "@ace/protocol";
import { PrMetadataEditor } from "./pr-metadata-editor.tsx";
const snapshot = ForgeLifecycleSnapshot.parse({
  pr: {
    repository: { forge: "github", host: "github.com", owner: "acme", name: "api" },
    number: 42,
  },
  id: "PR_42",
  version: "a".repeat(64),
  headSha: "a".repeat(40),
  baseSha: "b".repeat(40),
  state: "open",
  metadata: {
    title: "Original title",
    body: "Original description",
    baseBranch: "main",
    labels: ["bug"],
    assignees: ["octo"],
  },
  editableFields: ["title", "body", "baseBranch", "labels", "assignees"],
  actions: ["close"],
  unsupported: [],
});
const refused = async () => false;
beforeEach(() => localStorage.clear());

test("failed metadata saves and navigation retain incomplete text scoped to the repository PR", async () => {
  const editor = render(<PrMetadataEditor snapshot={snapshot} disabled={false} apply={refused} />);
  await userEvent.clear(screen.getByRole("textbox", { name: "PR description" }));
  await userEvent.type(screen.getByRole("textbox", { name: "PR description" }), "Keep this edit");
  await userEvent.click(screen.getByRole("button", { name: "Save PR metadata" }));
  expect(screen.getByRole<HTMLTextAreaElement>("textbox", { name: "PR description" }).value).toBe(
    "Keep this edit",
  );
  await userEvent.clear(screen.getByRole("textbox", { name: "PR title" }));
  editor.unmount();
  const other = {
    ...snapshot,
    pr: { ...snapshot.pr, repository: { ...snapshot.pr.repository, name: "web" } },
  };
  const next = render(<PrMetadataEditor snapshot={other} disabled={false} apply={refused} />);
  expect(screen.getByRole<HTMLInputElement>("textbox", { name: "PR title" }).value).toBe(
    "Original title",
  );
  next.unmount();
  render(<PrMetadataEditor snapshot={snapshot} disabled={false} apply={refused} />);
  expect(screen.getByRole<HTMLInputElement>("textbox", { name: "PR title" }).value).toBe("");
  expect(screen.getByRole<HTMLTextAreaElement>("textbox", { name: "PR description" }).value).toBe(
    "Keep this edit",
  );
  expect(screen.getByRole<HTMLButtonElement>("button", { name: "Save PR metadata" }).disabled).toBe(
    true,
  );
});

test("refreshing a stale edit preserves its intended change without overwriting outside metadata", async () => {
  let submitted: { action: ForgeLifecycleAction; version: string } | undefined;
  const apply = async (action: ForgeLifecycleAction, version: string) => {
    submitted = { action, version };
    return true;
  };
  const editor = render(<PrMetadataEditor snapshot={snapshot} disabled={false} apply={apply} />);
  await userEvent.clear(screen.getByRole("textbox", { name: "PR title" }));
  await userEvent.type(screen.getByRole("textbox", { name: "PR title" }), "My edited title");
  const refreshed = {
    ...snapshot,
    version: "b".repeat(64),
    metadata: { ...snapshot.metadata, body: "Changed on GitHub", baseBranch: "release" },
  };
  editor.rerender(<PrMetadataEditor snapshot={refreshed} disabled={false} apply={apply} />);
  expect(screen.getByText(/PR changed since this edit began/)).toBeTruthy();
  expect(screen.getByRole<HTMLButtonElement>("button", { name: "Save PR metadata" }).disabled).toBe(
    true,
  );
  await userEvent.click(screen.getByRole("button", { name: "Use refreshed PR for this edit" }));
  expect(screen.getByRole<HTMLTextAreaElement>("textbox", { name: "PR description" }).value).toBe(
    "Changed on GitHub",
  );
  expect(screen.getByRole<HTMLInputElement>("textbox", { name: "Base branch" }).value).toBe(
    "release",
  );
  await userEvent.click(screen.getByRole("button", { name: "Save PR metadata" }));
  await waitFor(() =>
    expect(submitted).toEqual({
      action: { kind: "edit", changes: { title: "My edited title" } },
      version: refreshed.version,
    }),
  );
});

test("clearing labels sends an empty set and missing field permission prevents editing", async () => {
  let submitted: ForgeLifecycleAction | undefined;
  render(
    <PrMetadataEditor
      snapshot={{ ...snapshot, editableFields: ["labels"] }}
      disabled={false}
      apply={async (action) => {
        submitted = action;
        return true;
      }}
    />,
  );
  expect(screen.getByRole<HTMLInputElement>("textbox", { name: "PR title" }).disabled).toBe(true);
  await userEvent.clear(screen.getByRole("textbox", { name: "PR labels" }));
  await userEvent.click(screen.getByRole("button", { name: "Save PR metadata" }));
  await waitFor(() => expect(submitted).toEqual({ kind: "edit", changes: { labels: [] } }));
});
