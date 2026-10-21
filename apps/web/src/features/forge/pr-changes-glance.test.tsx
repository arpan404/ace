import type { ReactNode } from "react";
import { expect, test } from "vitest";
import { render, screen } from "@testing-library/react";
import { ClientProvider } from "@ace/client-react";
import { QueryClientProvider } from "@tanstack/react-query";
import { WorkspaceId, type ForgePrDetail, type ForgePrFiles } from "@ace/protocol";
import { AppFrame, createQueryClient } from "@/app.tsx";
import { LayoutProvider } from "@/lib/layout.tsx";
import { harness } from "@/test/harness.tsx";
import { PrChangesGlance } from "./pr-changes-glance.tsx";
import { detail } from "./pr-workspace.fixture.ts";

const workspaceId = WorkspaceId.parse("api");
const moved: ForgePrDetail = { ...detail, status: { ...detail.status, headSha: "c".repeat(40) } };
const filesRead = (pr: ForgePrDetail) =>
  ({
    op: "forge.pr.files",
    workspaceId,
    repository: pr.status.ref.repository,
    number: pr.status.ref.number,
    page: 1,
    headSha: pr.status.headSha,
    baseSha: pr.baseSha,
  }) as const;
const changed = (pr: ForgePrDetail, path: string): ForgePrFiles => ({
  ref: pr.status.ref,
  baseSha: pr.baseSha,
  headSha: pr.status.headSha,
  files: [{ path, status: "modified", additions: 1, deletions: 1, patch: null, truncated: true }],
  truncated: false,
});

async function mount() {
  const app = harness();
  const queries = createQueryClient();
  await app.client.start();
  const frame = (children: ReactNode) => (
    <AppFrame environment={{ storage: app.storage, root: document.documentElement }}>
      <ClientProvider client={app.client}>
        <QueryClientProvider client={queries}>
          <LayoutProvider storage={app.storage}>{children}</LayoutProvider>
        </QueryClientProvider>
      </ClientProvider>
    </AppFrame>
  );
  const glance = (pr: ForgePrDetail) =>
    frame(<PrChangesGlance workspaceId="api" detail={pr} onOpenCode={() => {}} />);
  return { app, glance };
}

test("Changes says it is loading the changed files until they are read", async () => {
  const { app, glance } = await mount();
  app.daemon.workspace.setForgeRead(filesRead(detail), {
    resource: "prFiles",
    value: changed(detail, "page.ts"),
  });
  const release = app.daemon.workspace.holdForgeRead(filesRead(detail));
  render(glance(detail));
  expect(
    await screen.findByRole("status", { name: "Loading changed files" }, { timeout: 10_000 }),
  ).toBeTruthy();
  release();
  expect(await screen.findByText("page.ts", {}, { timeout: 10_000 })).toBeTruthy();
  expect(screen.queryByRole("status", { name: "Loading changed files" })).toBeNull();
});

test("a re-read detail with the same head and base reads the changed files once", async () => {
  const { app, glance } = await mount();
  app.daemon.workspace.setForgeRead(filesRead(detail), {
    resource: "prFiles",
    value: changed(detail, "page.ts"),
  });
  const view = render(glance(detail));
  expect(await screen.findByText("page.ts", {}, { timeout: 10_000 })).toBeTruthy();
  view.rerender(
    glance({ ...detail, status: { ...detail.status, title: "Fix reconnect, edited" } }),
  );
  expect(screen.getByText("page.ts")).toBeTruthy();
  expect(app.daemon.workspace.forgeReadCount(filesRead(detail))).toBe(1);
});

test("a moved head never leaves the old head's files showing as current", async () => {
  const { app, glance } = await mount();
  app.daemon.workspace.setForgeRead(filesRead(detail), {
    resource: "prFiles",
    value: changed(detail, "old.ts"),
  });
  app.daemon.workspace.setForgeRead(filesRead(moved), {
    resource: "prFiles",
    value: changed(moved, "new.ts"),
  });
  const release = app.daemon.workspace.holdForgeRead(filesRead(moved));
  const view = render(glance(detail));
  expect(await screen.findByText("old.ts", {}, { timeout: 10_000 })).toBeTruthy();
  view.rerender(glance(moved));
  expect(
    await screen.findByRole("status", { name: "Loading changed files" }, { timeout: 10_000 }),
  ).toBeTruthy();
  expect(screen.queryByText("old.ts")).toBeNull();
  release();
  expect(await screen.findByText("new.ts", {}, { timeout: 10_000 })).toBeTruthy();
});

test("Changes renders the detail's file list without a files read", async () => {
  const { app, glance } = await mount();
  const withFiles: ForgePrDetail = {
    ...detail,
    files: [
      { path: "src/app.ts", additions: 10, deletions: 2, status: "modified" },
      { path: "page.ts", additions: 1, deletions: 1, status: "added" },
    ],
  };
  render(glance(withFiles));
  expect(await screen.findByText("app.ts", {}, { timeout: 10_000 })).toBeTruthy();
  expect(screen.getByText("page.ts")).toBeTruthy();
  expect(app.daemon.workspace.forgeReadCount(filesRead(withFiles))).toBe(0);
});
