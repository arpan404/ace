import type { ReactNode } from "react";
import { afterEach, expect, test } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ClientProvider } from "@ace/client-react";
import { QueryClientProvider } from "@tanstack/react-query";
import { WorkspaceId, type ForgeFile, type ForgePrDetail } from "@ace/protocol";
import { AppFrame, createQueryClient } from "@/app.tsx";
import { LayoutProvider } from "@/lib/layout.tsx";
import { harness } from "@/test/harness.tsx";
import { PrFiles } from "./pr-files.tsx";
import { detail } from "./pr-workspace.fixture.ts";
import { reviewDetail, reviewHarness, reviewState } from "./review-harness.tsx";

afterEach(cleanup);

const workspaceId = WorkspaceId.parse("api");
const repository = detail.status.ref.repository;

const changed = (path: string, patch: string): ForgeFile => ({
  path,
  status: "modified",
  additions: 1,
  deletions: 1,
  patch,
  truncated: false,
});
const filesOp = (head: string, extra: { commit?: string; since?: string } = {}) => ({
  op: "forge.pr.files" as const,
  workspaceId,
  repository,
  number: 7,
  page: 1,
  headSha: head,
  baseSha: detail.baseSha,
  ...extra,
});
const filesRead = (files: ForgeFile[], head: string, extra: object = {}) => ({
  resource: "prFiles" as const,
  value: {
    ref: detail.status.ref,
    baseSha: detail.baseSha,
    headSha: head,
    files,
    truncated: false,
    ...extra,
  },
});

function codeTab(shown: ForgePrDetail) {
  return (
    <PrFiles
      workspaceId="api"
      repository={repository}
      detail={shown}
      context={{ workspaceId: "api", detail: shown, disabled: false, refresh: async () => true }}
    />
  );
}

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
  return {
    rerender: (next: ReactNode) => rendered.rerender(tree(next)),
    unmount: rendered.unmount,
  };
}

const commit = (sha: string, message: string) => ({
  sha,
  author: "octo",
  message,
  date: "2026-10-11T11:00:00Z",
  url: `https://github.com/acme/ace/commit/${sha}`,
});
const viewed = (state: "VIEWED" | "UNVIEWED") =>
  reviewState({
    viewed: [
      { path: "src/a.ts", state },
      { path: "src/b.ts", state },
    ],
  });
const box = (path: string) => screen.findByRole("checkbox", { name: `Viewed ${path}` });

type ViewItem = ["menuitemradio" | "menuitemcheckbox", string];
const split: ViewItem = ["menuitemradio", "Split"];
const noWhitespace: ViewItem = ["menuitemcheckbox", "Hide whitespace changes"];

/** Opens the View menu and finds a choice there. */
const viewItem = async ([role, name]: ViewItem) => {
  await userEvent.click(screen.getByRole("button", { name: "View" }));
  return screen.findByRole(role, { name });
};
/** Whether a View menu choice is on, closing the menu after. */
const chosen = async (item: ViewItem) => {
  const on = (await viewItem(item)).getAttribute("aria-checked") === "true";
  await userEvent.keyboard("{Escape}");
  return on;
};
const choose = async (item: ViewItem) => {
  await userEvent.click(await viewItem(item));
  await userEvent.keyboard("{Escape}");
};

test("a push keeps the layout and whitespace choice, and so does the next visit", async () => {
  const app = harness();
  app.daemon.workspace.setForgeRead(
    filesOp(detail.status.headSha),
    filesRead([changed("src/a.ts", "@@ -1 +1 @@\n-old\n+first")], detail.status.headSha),
  );
  const view = await mount(app, codeTab(detail));
  await screen.findByText("first");
  await choose(split);
  await choose(noWhitespace);
  // An agent pushes: the new head's files are read, the choices stay.
  const head = "e".repeat(40);
  app.daemon.workspace.setForgeRead(
    filesOp(head),
    filesRead([changed("src/a.ts", "@@ -1 +1 @@\n-old\n+pushed")], head),
  );
  view.rerender(codeTab({ ...detail, status: { ...detail.status, headSha: head } }));
  expect(await screen.findAllByText("pushed")).not.toHaveLength(0);
  expect(await chosen(split)).toBe(true);
  expect(await chosen(noWhitespace)).toBe(true);
  expect(screen.getByText(/^Pushed .* · your place kept$/)).toBeTruthy();
  // Kept on this device: the Code tab opened again starts the same way.
  view.unmount();
  await mount(app, codeTab(detail));
  await screen.findAllByText("first");
  expect(await chosen(split)).toBe(true);
});

test("Since your review shows only the commits after the viewer's latest review", async () => {
  const app = harness();
  const head = detail.status.headSha;
  const [reviewed, middle] = ["1".repeat(40), "2".repeat(40)];
  app.daemon.workspace.setForgeRead(
    { op: "forge.pr.commits", workspaceId, repository, number: 7, headSha: head },
    {
      resource: "prCommits",
      commits: [commit(reviewed, "Reviewed"), commit(middle, "Middle"), commit(head, "Head")],
      truncated: false,
    },
  );
  app.daemon.workspace.setForgeRead(
    { op: "forge.pr.reviewers", workspaceId, repository, number: 7 },
    {
      resource: "prReviewers",
      value: {
        requested: [],
        reviews: [
          { id: 1, login: "me", state: "COMMENTED", submittedAt: null, commitSha: reviewed },
        ],
        suggested: [],
        author: "octo",
        viewer: "me",
        canRequest: false,
        canDismiss: false,
      },
    },
  );
  app.daemon.workspace.setForgeRead(
    filesOp(head),
    filesRead([changed("src/old.ts", "@@ -1 +1 @@\n-a\n+everything")], head),
  );
  app.daemon.workspace.setForgeRead(
    filesOp(head, { commit: head, since: reviewed }),
    filesRead([changed("src/new.ts", "@@ -1 +1 @@\n-a\n+since review")], head, {
      baseSha: reviewed,
      commit: head,
      since: reviewed,
    }),
  );
  await mount(app, codeTab(detail));
  await screen.findByText("everything");
  await userEvent.click(screen.getByRole("combobox", { name: "Commit range" }));
  await userEvent.click(
    await screen.findByRole("option", { name: "Since your review · 2 commits" }),
  );
  expect(await screen.findByText("since review")).toBeTruthy();
  expect(screen.queryByText("everything")).toBeNull();
});

test("a fold between GitHub's hunks opens on the file's own unchanged lines", async () => {
  const app = harness();
  const head = detail.status.headSha;
  const lines = Array.from({ length: 21 }, (_, i) => `line ${i + 1}`);
  app.daemon.workspace.setForgeRead(
    filesOp(head),
    filesRead(
      [
        changed(
          "src/fold.txt",
          "@@ -1,2 +1,2 @@\n-a\n+line 1\n line 2\n@@ -20,2 +20,2 @@\n-x\n+line 20\n line 21",
        ),
      ],
      head,
    ),
  );
  for (const [sha, text] of [
    [detail.baseSha, `a\n${lines.slice(1, 19).join("\n")}\nx\nline 21\n`],
    [head, `${lines.join("\n")}\n`],
  ] as const)
    app.daemon.workspace.setForgeRead(
      { op: "forge.file.content", workspaceId, repository, sha, path: "src/fold.txt", page: 1 },
      { resource: "fileContent", value: { kind: "text", text, size: text.length } },
    );
  await mount(app, codeTab(detail));
  await screen.findByText("line 20");
  expect(screen.queryByText("line 10")).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "Show 17 unchanged lines" }));
  expect(await screen.findByText("line 10")).toBeTruthy();
  expect(screen.getByText("line 3")).toBeTruthy();
});

test("Viewed shows at once, a second mark waits its turn, and a refusal puts it back", async () => {
  const shown = reviewDetail({}, "author");
  const head = shown.status.headSha;
  const view = await reviewHarness({
    detail: shown,
    state: viewed("UNVIEWED"),
    ui: (
      <PrFiles
        workspaceId="api"
        repository={shown.status.ref.repository}
        detail={shown}
        context={{ workspaceId: "api", detail: shown, disabled: false, refresh: async () => true }}
      />
    ),
  });
  view.daemon.workspace.setForgeRead(
    {
      op: "forge.pr.files",
      workspaceId,
      repository: shown.status.ref.repository,
      number: 42,
      page: 1,
      headSha: head,
      baseSha: shown.baseSha,
    },
    {
      resource: "prFiles",
      value: {
        ref: shown.status.ref,
        baseSha: shown.baseSha,
        headSha: head,
        files: [
          changed("src/a.ts", "@@ -1 +1 @@\n-a\n+A"),
          changed("src/b.ts", "@@ -1 +1 @@\n-b\n+B"),
        ],
        truncated: false,
      },
    },
  );
  view.hold();
  await userEvent.click(await box("src/a.ts"));
  expect((await box("src/a.ts")).getAttribute("aria-checked")).toBe("true");
  // GitHub hasn't answered the first: the second is still taken, not dropped.
  await userEvent.click(await box("src/b.ts"));
  expect((await box("src/b.ts")).getAttribute("aria-checked")).toBe("true");
  view.daemon.workspace.setForgeRead(
    {
      op: "forge.pr.review-state",
      workspaceId,
      repository: shown.status.ref.repository,
      number: 42,
    },
    { resource: "prReviewState", value: viewed("VIEWED") },
  );
  view.release();
  await waitFor(() =>
    expect(view.sent.map((action) => action.kind === "file.view" && action.path)).toEqual([
      "src/a.ts",
      "src/b.ts",
    ]),
  );
  await waitFor(async () =>
    expect((await box("src/b.ts")).getAttribute("aria-checked")).toBe("true"),
  );
  // Unmarking one GitHub refuses: the mark goes back and says so.
  view.refuse("conflict");
  await userEvent.click(await box("src/a.ts"));
  const header = (await box("src/a.ts")).closest("section");
  expect(await within(header as HTMLElement).findByText("Couldn't save")).toBeTruthy();
  expect((await box("src/a.ts")).getAttribute("aria-checked")).toBe("true");
  await view.close();
});

test("a file's box in the files tree marks it Viewed, and the diff's own box agrees", async () => {
  const shown = reviewDetail({}, "author");
  const head = shown.status.headSha;
  const view = await reviewHarness({
    detail: shown,
    state: viewed("UNVIEWED"),
    ui: (
      <PrFiles
        workspaceId="api"
        repository={shown.status.ref.repository}
        detail={shown}
        context={{ workspaceId: "api", detail: shown, disabled: false, refresh: async () => true }}
      />
    ),
  });
  view.daemon.workspace.setForgeRead(
    { ...filesOp(head), repository: shown.status.ref.repository, number: 42 },
    {
      resource: "prFiles",
      value: {
        ref: shown.status.ref,
        baseSha: shown.baseSha,
        headSha: head,
        files: [changed("src/a.ts", "@@ -1 +1 @@\n-a\n+A")],
        truncated: false,
      },
    },
  );
  view.hold();
  const tree = await screen.findByRole("tree", { name: "Changed files" });
  const ticked = await within(tree).findByRole("checkbox", { name: "Mark src/a.ts viewed" });
  expect(ticked.getAttribute("aria-checked")).toBe("false");
  await userEvent.click(ticked);
  expect(ticked.getAttribute("aria-checked")).toBe("true");
  expect((await box("src/a.ts")).getAttribute("aria-checked")).toBe("true");
  view.release();
  await waitFor(() =>
    expect(view.sent.map((action) => action.kind === "file.view" && action.path)).toEqual([
      "src/a.ts",
    ]),
  );
  await view.close();
});
