import type { ReactNode } from "react";
import { expect, test } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ClientProvider } from "@ace/client-react";
import { QueryClientProvider } from "@tanstack/react-query";
import { WorkspaceId, type ForgeFile, type ForgePrFiles } from "@ace/protocol";
import { AppFrame, createQueryClient } from "@/app.tsx";
import { LayoutProvider } from "@/lib/layout.tsx";
import { harness } from "@/test/harness.tsx";
import { PrFiles } from "./pr-files.tsx";
import { PrReviewWorkspace } from "./pr-review-context.tsx";
import { detail } from "./pr-workspace.fixture.ts";
import type { PrWorkspaceContext } from "./pr-extensions.ts";

const repository = detail.status.ref.repository;
const workspaceId = WorkspaceId.parse("api");

const page = (number: number) => ({
  op: "forge.pr.files" as const,
  workspaceId,
  repository,
  number: 7,
  page: number,
  headSha: detail.status.headSha,
  baseSha: detail.baseSha,
});
const changed = (path: string, added: string, patch?: string | null): ForgeFile => ({
  path,
  status: "modified",
  additions: 1,
  deletions: 1,
  patch: patch === undefined ? `@@ -1 +1 @@\n-old\n+${added}` : patch,
  truncated: false,
});
const filesPage = (
  files: ForgeFile[],
  nextPage?: number,
): { resource: "prFiles"; value: ForgePrFiles } => ({
  resource: "prFiles",
  value: {
    ref: detail.status.ref,
    baseSha: detail.baseSha,
    headSha: detail.status.headSha,
    files,
    truncated: false,
    ...(nextPage ? { nextPage } : {}),
  },
});

type Shown = typeof detail;
const contextOf = (shown: Shown): PrWorkspaceContext => ({
  workspaceId: "api",
  detail: shown,
  disabled: false,
  refresh: async () => true,
});

async function mount(app: ReturnType<typeof harness>, view: ReactNode) {
  await app.client.start();
  render(
    <AppFrame environment={{ storage: app.storage, root: document.documentElement }}>
      <ClientProvider client={app.client}>
        <QueryClientProvider client={createQueryClient()}>
          <LayoutProvider storage={app.storage}>{view}</LayoutProvider>
        </QueryClientProvider>
      </ClientProvider>
    </AppFrame>,
  );
}
const codeTab = (shown: Shown = detail) => (
  <PrFiles workspaceId="api" repository={repository} detail={shown} context={contextOf(shown)} />
);

const thread = (id: number, line: number | null, outdated: boolean, resolved = false) => ({
  id: `t${id}`,
  resolved,
  outdated,
  file: "src/first.ts",
  line,
  comments: [
    {
      kind: "inline" as const,
      id,
      body: `Note ${id}`,
      author: "reviewer",
      file: "src/first.ts",
      line,
      replyTo: null,
      updatedAt: "2026-10-11T12:04:00Z",
    },
  ],
});

test("every page of changed files joins one scroll without paging buttons", async () => {
  const app = harness();
  app.daemon.workspace.setForgeRead(page(1), filesPage([changed("src/first.ts", "one")], 2));
  app.daemon.workspace.setForgeRead(page(2), filesPage([changed("src/second.ts", "two")]));
  await mount(app, codeTab({ ...detail, changedFiles: 2 }));
  const diff = await screen.findByRole("region", { name: "Hosted PR diff" });
  expect(await within(diff).findByText("one")).toBeTruthy();
  expect(await within(diff).findByText("two")).toBeTruthy();
  expect(within(diff).queryByRole("button", { name: /Next files|Previous files/ })).toBeNull();
  expect(within(diff).getByText("2 files")).toBeTruthy();
});

test("a page that fails to load offers an inline retry that resumes the scroll", async () => {
  const app = harness();
  app.daemon.workspace.setForgeRead(page(1), filesPage([changed("src/first.ts", "one")], 2));
  await mount(app, codeTab());
  expect(await screen.findByText("one")).toBeTruthy();
  const failure = await screen.findByRole("alert");
  expect(failure.textContent).toContain("The rest of this diff couldn't load.");
  app.daemon.workspace.setForgeRead(page(2), filesPage([changed("src/second.ts", "two")]));
  await userEvent.click(within(failure).getByRole("button", { name: "Retry" }));
  expect(await screen.findByText("two")).toBeTruthy();
  expect(screen.queryByRole("alert")).toBeNull();
});

test("missing viewed state and withheld patches are one toolbar warning, never per-file text", async () => {
  const app = harness();
  app.daemon.workspace.setForgeRead(
    page(1),
    filesPage([changed("src/first.ts", "one"), changed("assets/logo.png", "", null)]),
  );
  await mount(app, codeTab({ ...detail, changedFiles: 2 }));
  await screen.findByText("one");
  const toolbar = screen.getByRole("toolbar", { name: "Diff controls" });
  const warnings = within(toolbar).getAllByRole("button", { name: /unavailable|withheld/ });
  expect(warnings).toHaveLength(1);
  expect(warnings[0]?.getAttribute("aria-label")).toMatch(/viewed state is unavailable/);
  expect(warnings[0]?.getAttribute("aria-label")).toMatch(/withheld/);
  const files = screen.getByRole("region", { name: "Hosted PR diff" });
  expect(within(files).queryByText(/unavailable|withheld|Binary/)).toBeNull();
  expect(screen.queryByRole("checkbox", { name: /^Viewed / })).toBeNull();
});

test("a file GitHub dismissed after a push reads Changed and stays open", async () => {
  const app = harness();
  app.daemon.workspace.setForgeRead(page(1), filesPage([changed("src/first.ts", "one")]));
  app.daemon.workspace.setForgeRead(
    { op: "forge.pr.review-state", workspaceId, repository, number: 7 },
    {
      resource: "prReviewState",
      value: {
        viewer: "reviewer",
        headSha: detail.status.headSha,
        drafts: [],
        viewed: [{ path: "src/first.ts", state: "DISMISSED" }],
        canReview: true,
        canComment: true,
        resolvableThreads: [],
        operations: [],
      },
    },
  );
  await mount(
    app,
    <PrReviewWorkspace workspaceId="api" detail={detail} onRefresh={() => {}}>
      {codeTab()}
    </PrReviewWorkspace>,
  );
  expect(await screen.findByText("Changed")).toBeTruthy();
  expect(
    screen.getByRole("checkbox", { name: "Viewed src/first.ts" }).getAttribute("aria-checked"),
  ).toBe("false");
  expect(screen.getByText("one")).toBeTruthy();
  expect(screen.getByText("1 file · 0 / 1 viewed")).toBeTruthy();
  expect(
    within(screen.getByRole("toolbar", { name: "Diff controls" })).queryByRole("button", {
      name: /unavailable|withheld/,
    }),
  ).toBeNull();
});

test("open review threads the diff can't place gather in one strip above the files", async () => {
  const app = harness();
  app.daemon.workspace.setForgeRead(page(1), filesPage([changed("src/first.ts", "one")]));
  await mount(
    app,
    codeTab({
      ...detail,
      status: {
        ...detail.status,
        reviewThreads: [
          thread(1, null, true),
          thread(2, 1, false),
          thread(3, 40, false),
          thread(4, null, true, true),
        ],
      },
    }),
  );
  await screen.findByText("one");
  const strip = await screen.findByRole("group", { name: "Conversations not on the current diff" });
  // Outdated, or on a line the patch never draws; not the one on line 1, nor the resolved one.
  expect(strip.textContent).toContain("Note 1");
  expect(strip.textContent).toContain("Note 3");
  expect(strip.textContent).not.toContain("Note 2");
  expect(strip.textContent).not.toContain("Note 4");
});
