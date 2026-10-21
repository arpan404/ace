import { expect, test } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ClientProvider } from "@ace/client-react";
import { QueryClientProvider } from "@tanstack/react-query";
import {
  WorkspaceId,
  type ForgeFile,
  type ForgeFileContent,
  type ForgeImageType,
} from "@ace/protocol";
import { AppFrame, createQueryClient } from "@/app.tsx";
import { LayoutProvider } from "@/lib/layout.tsx";
import { harness } from "@/test/harness.tsx";
import { PrFiles } from "./pr-files.tsx";
import { detail } from "./pr-workspace.fixture.ts";

const repository = detail.status.ref.repository;
const workspaceId = WorkspaceId.parse("api");
const base = detail.baseSha;
const head = detail.status.headSha;

function serveFiles(app: ReturnType<typeof harness>, files: ForgeFile[]) {
  app.daemon.workspace.setForgeRead(
    {
      op: "forge.pr.files",
      workspaceId,
      repository,
      number: 7,
      page: 1,
      headSha: head,
      baseSha: base,
    },
    {
      resource: "prFiles",
      value: { ref: detail.status.ref, baseSha: base, headSha: head, files, truncated: false },
    },
  );
}
function serveSide(
  app: ReturnType<typeof harness>,
  side: { sha: string; path: string; page?: number; image?: ForgeImageType },
  value: ForgeFileContent,
) {
  app.daemon.workspace.setForgeRead(
    {
      op: "forge.file.content",
      workspaceId,
      repository,
      sha: side.sha,
      path: side.path,
      page: side.page ?? 1,
      ...(side.image ? { image: side.image } : {}),
    },
    { resource: "fileContent", value },
  );
}
const withheld = (path: string, status = "modified", lines = 2): ForgeFile => ({
  path,
  status,
  additions: lines / 2,
  deletions: lines / 2,
  patch: null,
  truncated: true,
});
const text = (value: string, nextPage?: number): ForgeFileContent => ({
  kind: "text",
  text: value,
  size: value.length,
  ...(nextPage ? { nextPage } : {}),
});

const image = (data: string, size: number): ForgeFileContent => ({
  kind: "image",
  type: "image/png",
  data,
  size,
});
const notebook = (cells: unknown[]) =>
  JSON.stringify({ metadata: { language_info: { name: "python" } }, cells });

async function mount(app: ReturnType<typeof harness>) {
  await app.client.start();
  render(
    <AppFrame environment={{ storage: app.storage, root: document.documentElement }}>
      <ClientProvider client={app.client}>
        <QueryClientProvider client={createQueryClient()}>
          <LayoutProvider storage={app.storage}>
            <PrFiles
              workspaceId="api"
              repository={repository}
              detail={{ ...detail, changedFiles: 1 }}
              context={{
                workspaceId: "api",
                detail,
                disabled: false,
                refresh: async () => true,
              }}
            />
          </LayoutProvider>
        </QueryClientProvider>
      </ClientProvider>
    </AppFrame>,
  );
  return screen.findByRole("region", { name: "Hosted PR diff" });
}

test("a patch GitHub withheld is diffed from both sides, read page by page", async () => {
  const app = harness();
  serveFiles(app, [withheld("src/big.ts")]);
  serveSide(app, { sha: base, path: "src/big.ts" }, text("keep\nold line\n"));
  serveSide(app, { sha: head, path: "src/big.ts" }, text("keep\nnew ", 2));
  serveSide(app, { sha: head, path: "src/big.ts", page: 2 }, text("line\n"));
  const diff = await mount(app);
  expect(await within(diff).findByText("new line")).toBeTruthy();
  expect(within(diff).getByText("old line")).toBeTruthy();
});

test("a withheld diff with very many changed lines reads only when asked", async () => {
  const app = harness();
  serveFiles(app, [withheld("data/fixtures.txt", "modified", 12_000)]);
  serveSide(app, { sha: base, path: "data/fixtures.txt" }, text("first version\n"));
  serveSide(app, { sha: head, path: "data/fixtures.txt" }, text("second version\n"));
  const diff = await mount(app);
  const load = await within(diff).findByRole("button", { name: "Load diff" });
  expect(within(diff).getByText("12,000 lines changed")).toBeTruthy();
  const headSide = {
    op: "forge.file.content" as const,
    workspaceId,
    repository,
    sha: head,
    path: "data/fixtures.txt",
    page: 1,
  };
  expect(app.daemon.workspace.forgeReadCount(headSide)).toBe(0);
  await userEvent.click(load);
  expect(await within(diff).findByText("second version")).toBeTruthy();
});

test("a changed image shows before and after, side by side or swiped", async () => {
  const app = harness();
  serveFiles(app, [withheld("assets/logo.png", "modified", 0)]);
  serveSide(app, { sha: base, path: "assets/logo.png", image: "image/png" }, image("AAAA", 1200));
  serveSide(app, { sha: head, path: "assets/logo.png", image: "image/png" }, image("BBBB", 2400));
  const diff = await mount(app);
  const before = await within(diff).findByRole("img", { name: "assets/logo.png before" });
  expect(before.getAttribute("src")).toBe("data:image/png;base64,AAAA");
  expect(within(diff).getByRole("img", { name: "assets/logo.png after" }).getAttribute("src")).toBe(
    "data:image/png;base64,BBBB",
  );
  await userEvent.click(within(diff).getByRole("button", { name: "Swipe" }));
  expect(within(diff).getByRole("slider", { name: "Swipe between before and after" })).toBeTruthy();
  expect(within(diff).getByText("1 KB → 2 KB")).toBeTruthy();
});

test("a binary file says so, with its sizes, instead of an empty diff", async () => {
  const app = harness();
  serveFiles(app, [withheld("bin/tool", "modified", 0)]);
  serveSide(app, { sha: base, path: "bin/tool" }, { kind: "binary", size: 3000 });
  serveSide(app, { sha: head, path: "bin/tool" }, { kind: "binary", size: 5000 });
  const diff = await mount(app);
  expect(await within(diff).findByText("Binary file · 3 KB → 5 KB")).toBeTruthy();
  expect(within(diff).queryByText("No text changes to show.")).toBeNull();
});

test("markdown reads rendered with its changed blocks marked, and switches to its source diff", async () => {
  const app = harness();
  serveFiles(app, [
    {
      path: "README.md",
      status: "modified",
      additions: 1,
      deletions: 1,
      patch: "@@ -1,3 +1,3 @@\n # Title\n \n-Old paragraph\n+New paragraph",
      truncated: false,
    },
  ]);
  serveSide(app, { sha: base, path: "README.md" }, text("# Title\n\nOld paragraph\n"));
  serveSide(app, { sha: head, path: "README.md" }, text("# Title\n\nNew paragraph\n"));
  const diff = await mount(app);
  const rendered = await within(diff).findByRole("group", {
    name: "Rendered changes to README.md",
  });
  expect(await within(rendered).findByRole("heading", { name: "Title" })).toBeTruthy();
  expect(within(rendered).getByText("Removed:")).toBeTruthy();
  expect(within(rendered).getByText("Old paragraph")).toBeTruthy();
  expect(within(rendered).getByText("New paragraph")).toBeTruthy();
  await userEvent.click(within(diff).getByRole("button", { name: "Show source of README.md" }));
  expect(within(diff).queryByRole("group", { name: "Rendered changes to README.md" })).toBeNull();
  expect(within(diff).getByText("# Title")).toBeTruthy();
});

test("a notebook reads as cells, with an added cell and its output marked", async () => {
  const app = harness();
  const first = { cell_type: "markdown", source: ["# Analysis"] };
  const added = {
    cell_type: "code",
    source: "print(41 + 1)",
    outputs: [{ output_type: "stream", name: "stdout", text: ["42\n"] }],
  };
  serveFiles(app, [withheld("analysis.ipynb")]);
  serveSide(app, { sha: base, path: "analysis.ipynb" }, text(notebook([first])));
  serveSide(app, { sha: head, path: "analysis.ipynb" }, text(notebook([first, added])));
  const diff = await mount(app);
  const rendered = await within(diff).findByRole("group", {
    name: "Rendered changes to analysis.ipynb",
  });
  expect(await within(rendered).findByRole("heading", { name: "Analysis" })).toBeTruthy();
  expect(within(rendered).getByText("Added:")).toBeTruthy();
  expect(within(rendered).getByText("42")).toBeTruthy();
  expect(within(rendered).queryByText("Removed:")).toBeNull();
});
