import type { ReactNode } from "react";
import { expect, test } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ClientProvider } from "@ace/client-react";
import { QueryClientProvider } from "@tanstack/react-query";
import { WorkspaceId, type ForgeFile, type ForgePrFiles } from "@ace/protocol";
import { AppFrame, createQueryClient } from "@/app.tsx";
import { LayoutProvider } from "@/lib/layout.tsx";
import { harness } from "@/test/harness.tsx";
import { PrFiles } from "./pr-files.tsx";
import { PrReviewWorkspace } from "./pr-review-context.tsx";
import { PrUiProvider } from "./pr-ui-store.tsx";
import { reviewState } from "./review-harness.tsx";
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
  headSha = detail.status.headSha,
): { resource: "prFiles"; value: ForgePrFiles } => ({
  resource: "prFiles",
  value: {
    ref: detail.status.ref,
    baseSha: detail.baseSha,
    headSha,
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
  const query = createQueryClient();
  const tree = (shown: ReactNode) => (
    <AppFrame environment={{ storage: app.storage, root: document.documentElement }}>
      <ClientProvider client={app.client}>
        <QueryClientProvider client={query}>
          <LayoutProvider storage={app.storage}>{shown}</LayoutProvider>
        </QueryClientProvider>
      </ClientProvider>
    </AppFrame>
  );
  const rendered = render(tree(view));
  return (next: ReactNode) => rendered.rerender(tree(next));
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

test("missing viewed state is a toolbar warning, never per-file text", async () => {
  const app = harness();
  app.daemon.workspace.setForgeRead(page(1), filesPage([changed("src/first.ts", "one")]));
  await mount(app, codeTab());
  await screen.findByText("one");
  const toolbar = screen.getByRole("toolbar", { name: "Diff controls" });
  const warnings = within(toolbar).getAllByRole("button", { name: /unavailable/ });
  expect(warnings).toHaveLength(1);
  expect(warnings[0]?.getAttribute("aria-label")).toMatch(/viewed state is unavailable/);
  const files = screen.getByRole("region", { name: "Hosted PR diff" });
  expect(within(files).queryByText(/unavailable/)).toBeNull();
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
      name: /unavailable/,
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

const follows = (a: Node, b: Node) =>
  (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;

test("each conversation sits under the line it's on, on the side it was written on", async () => {
  const app = harness();
  app.daemon.workspace.setForgeRead(page(1), filesPage([changed("src/first.ts", "one")]));
  await mount(
    app,
    codeTab({
      ...detail,
      status: {
        ...detail.status,
        reviewThreads: [
          { ...thread(2, 1, false), side: "RIGHT" as const },
          { ...thread(5, 1, false), side: "LEFT" as const },
        ],
      },
    }),
  );
  const added = await screen.findByText("one");
  const removed = screen.getByText("old");
  const onDeleted = screen.getByText("Note 5");
  const onAdded = screen.getByText("Note 2");
  // The deleted line's conversation comes right after it, before the added line.
  expect(follows(removed, onDeleted) && follows(onDeleted, added)).toBe(true);
  expect(follows(added, onAdded)).toBe(true);
  expect(screen.queryByRole("group", { name: "Conversations not on the current diff" })).toBeNull();
});

/** Two changes with unknown lines folded between them: new lines 1–2, then 20–21. */
const twoChanges = changed(
  "src/first.ts",
  "",
  "@@ -1,2 +1,2 @@\n-a\n+b\n c\n@@ -20,2 +20,2 @@\n-x\n+y\n z",
);

const reviewed = (shown: Shown) => (
  <PrUiProvider>
    <PrReviewWorkspace workspaceId="api" detail={shown} onRefresh={() => {}}>
      {codeTab(shown)}
    </PrReviewWorkspace>
  </PrUiProvider>
);
function serveReview(app: ReturnType<typeof harness>, headSha = detail.status.headSha) {
  app.daemon.workspace.setForgeRead(
    { op: "forge.pr.review-state", workspaceId, repository, number: 7 },
    { resource: "prReviewState", value: reviewState({ headSha }) },
  );
}

async function reviewing(app: ReturnType<typeof harness>, files: ForgeFile[] = [twoChanges]) {
  app.daemon.workspace.setForgeRead(page(1), filesPage(files));
  serveReview(app);
  return mount(app, reviewed(detail));
}

async function pickLine(name: string) {
  const button = await screen.findByRole("button", { name });
  button.focus();
  await userEvent.keyboard("{Enter}");
}

test("a pick stops at lines the diff doesn't show rather than spanning them", async () => {
  const app = harness();
  await reviewing(app);
  await screen.findByText("y");
  await pickLine("Comment on line 1");
  await screen.findByText("Commenting on line 1");
  // Shift-click line 21, past the fold: the pick reaches line 2, the last line shown.
  fireEvent.pointerDown(screen.getByRole("button", { name: "Comment on line 21" }), {
    button: 0,
    shiftKey: true,
  });
  fireEvent.pointerUp(window);
  await screen.findByText("Commenting on lines 1–2");
});

test("a comment being written keeps its text when its lines unmount and come back, without taking focus", async () => {
  const app = harness();
  await reviewing(app);
  await screen.findByText("y");
  await pickLine("Comment on line 1");
  const field = await screen.findByRole<HTMLTextAreaElement>("textbox", { name: "Line comment" });
  // The pick asked for it, so focus arrives.
  await waitFor(() => expect(document.activeElement).toBe(field));
  await userEvent.type(field, "Keep me");
  const header = screen.getByRole("button", { name: /src\/first\.ts/, expanded: true });
  await userEvent.click(header);
  expect(screen.queryByRole("textbox", { name: "Line comment" })).toBeNull();
  await userEvent.click(header);
  expect(
    (await screen.findByRole<HTMLTextAreaElement>("textbox", { name: "Line comment" })).value,
  ).toBe("Keep me");
  await new Promise((resolve) => setTimeout(resolve, 150));
  expect(document.activeElement).toBe(header);
});

test("after a push the picked lines are dropped, and the text waits for the next pick", async () => {
  const app = harness();
  const rerender = await reviewing(app);
  await screen.findByText("y");
  await pickLine("Comment on line 1");
  await userEvent.type(await screen.findByRole("textbox", { name: "Line comment" }), "Keep me");
  // The author pushes: the same line numbers now name other code.
  const pushedHead = "e".repeat(40);
  const pushed = { ...detail, status: { ...detail.status, headSha: pushedHead } };
  app.daemon.workspace.setForgeRead(
    { ...page(1), headSha: pushedHead },
    filesPage([changed("src/first.ts", "", "@@ -1 +1 @@\n-a\n+pushed")], undefined, pushedHead),
  );
  serveReview(app, pushedHead);
  rerender(reviewed(pushed));
  await screen.findByText("pushed");
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(screen.queryByRole("textbox", { name: "Line comment" })).toBeNull();
  await pickLine("Comment on line 1");
  expect(
    (await screen.findByRole<HTMLTextAreaElement>("textbox", { name: "Line comment" })).value,
  ).toBe("Keep me");
});

test("a pick on a line from an opened fold opens the comment and says GitHub can't take it", async () => {
  const app = harness();
  const lines = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`);
  const after = lines.map((line, i) => (i === 14 ? "changed 15" : line));
  app.daemon.workspace.setForgeRead(
    page(1),
    filesPage([{ ...changed("src/whole.ts", ""), patch: null, truncated: true }]),
  );
  for (const [sha, text] of [
    [detail.baseSha, `${lines.join("\n")}\n`],
    [detail.status.headSha, `${after.join("\n")}\n`],
  ] as const)
    app.daemon.workspace.setForgeRead(
      { op: "forge.file.content", workspaceId, repository, sha, path: "src/whole.ts", page: 1 },
      { resource: "fileContent", value: { kind: "text", text, size: text.length } },
    );
  serveReview(app);
  await mount(app, reviewed(detail));
  await screen.findByText("changed 15");
  await userEvent.click(await screen.findByRole("button", { name: /11 unchanged lines/ }));
  await pickLine("Comment on line 2");
  await screen.findByText("Commenting on line 2");
  await screen.findByText(
    "GitHub didn't send this file's changes, so it can't take a comment on its lines.",
  );
});

test("in split view a comment on the old side of an unchanged line sits in the left column", async () => {
  const app = harness();
  app.daemon.workspace.setForgeRead(page(1), filesPage([twoChanges]));
  serveReview(app);
  const leftThread = { ...thread(6, 2, false), side: "LEFT" as const };
  const shown = { ...detail, status: { ...detail.status, reviewThreads: [leftThread] } };
  await mount(app, reviewed(shown));
  await screen.findByText("Note 6");
  await userEvent.click(screen.getByRole("button", { name: "Split diff" }));
  const before = await screen.findByRole("region", { name: "src/first.ts before" });
  const after = screen.getByRole("region", { name: "src/first.ts after" });
  expect(within(before).getByText("Note 6")).toBeTruthy();
  expect(within(after).queryByText("Note 6")).toBeNull();
});
