import { useState } from "react";
import { expect, test } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ClientProvider } from "@ace/client-react";
import { QueryClientProvider } from "@tanstack/react-query";
import { WorkspaceId, type ForgePrFiles } from "@ace/protocol";
import { AppFrame, createQueryClient } from "@/app.tsx";
import { LayoutProvider } from "@/lib/layout.tsx";
import { harness } from "@/test/harness.tsx";
import { PrFiles } from "./pr-files.tsx";
import { detail } from "./pr-workspace.fixture.ts";
import type { PrDiffContext, PrWorkspaceContext, PrWorkspaceExtensions } from "./pr-extensions.ts";

const repository = detail.status.ref.repository;
const historical = "c".repeat(40);
const parent = "d".repeat(40);
const version = (context: PrDiffContext) =>
  `${context.files.baseSha}/${context.files.headSha}/${context.files.commit ?? "all"}`;
const context: PrWorkspaceContext = {
  workspaceId: "api",
  detail,
  disabled: false,
  refresh: async () => true,
};
const files = (baseSha: string, headSha: string, added: string): ForgePrFiles => ({
  ref: detail.status.ref,
  baseSha,
  headSha,
  files: [
    {
      path: "src/page.ts",
      status: "modified",
      additions: 1,
      deletions: 1,
      patch: `@@ -1 +1 @@\n-before\n+${added}`,
      truncated: false,
    },
  ],
  truncated: false,
});
const annotation: NonNullable<PrWorkspaceExtensions["annotation"]> = (_path, target, range) =>
  target.side === "new" ? <output aria-label="Annotation version">{version(range)}</output> : null;

function DiffExample() {
  const [viewed, setViewed] = useState<ReadonlySet<string>>(new Set());
  const [draft, setDraft] = useState("");
  return (
    <>
      <PrFiles
        workspaceId="api"
        repository={repository}
        detail={detail}
        context={context}
        extensions={{
          annotation,
          onLineComment: (_path, line, range) =>
            setDraft(`Draft ${version(range)} ${line.side}:${line.start}`),
          viewedCount: (range) => (viewed.has(version(range)) ? 1 : 0),
          viewed: (_file, range) => ({
            checked: viewed.has(version(range)),
            disabled: false,
            change: async (checked) => {
              setViewed((previous) => {
                const next = new Set(previous);
                if (checked) next.add(version(range));
                else next.delete(version(range));
                return next;
              });
            },
          }),
        }}
      />
      <p>{draft}</p>
    </>
  );
}

async function chooseCommit(name: string | RegExp) {
  await userEvent.click(screen.getByRole("combobox", { name: "Commit range" }));
  await userEvent.click(await screen.findByRole("option", { name }));
}

test("historical diffs bind annotations, line drafts and viewed marks to the displayed commit and parent", async () => {
  const app = harness();
  const workspaceId = WorkspaceId.parse("api");
  app.daemon.workspace.setForgeRead(
    {
      op: "forge.pr.commits",
      workspaceId,
      repository,
      number: 7,
      page: 1,
      headSha: detail.status.headSha,
    },
    {
      resource: "prCommits",
      commits: [
        {
          sha: historical,
          author: "octo",
          message: "Historical commit",
          date: "2026-10-11T11:00:00Z",
          url: `https://github.com/acme/ace/commit/${historical}`,
        },
      ],
      truncated: false,
    },
  );
  app.daemon.workspace.setForgeRead(
    {
      op: "forge.pr.files",
      workspaceId,
      repository,
      number: 7,
      page: 1,
      headSha: detail.status.headSha,
      baseSha: detail.baseSha,
    },
    { resource: "prFiles", value: files(detail.baseSha, detail.status.headSha, "current") },
  );
  app.daemon.workspace.setForgeRead(
    {
      op: "forge.pr.files",
      workspaceId,
      repository,
      number: 7,
      page: 1,
      headSha: detail.status.headSha,
      baseSha: detail.baseSha,
      commit: historical,
    },
    {
      resource: "prFiles",
      value: { ...files(parent, historical, "historical"), commit: historical },
    },
  );
  await app.client.start();
  render(
    <AppFrame environment={{ storage: app.storage, root: document.documentElement }}>
      <ClientProvider client={app.client}>
        <QueryClientProvider client={createQueryClient()}>
          <LayoutProvider storage={app.storage}>
            <DiffExample />
          </LayoutProvider>
        </QueryClientProvider>
      </ClientProvider>
    </AppFrame>,
  );
  await screen.findByText("current");
  await chooseCommit(/Historical commit/);
  await screen.findByText("historical");
  const identity = `${parent}/${historical}/${historical}`;
  expect(screen.getByRole("status", { name: "Annotation version" }).textContent).toBe(identity);
  const comment = await screen.findByRole<HTMLButtonElement>("button", {
    name: "Comment on line 1",
  });
  comment.focus();
  await userEvent.keyboard("{Enter}");
  await screen.findByText(`Draft ${identity} new:1`);
  await userEvent.click(screen.getByRole("checkbox", { name: "Viewed src/page.ts" }));
  await waitFor(() =>
    expect(
      screen.getByRole<HTMLInputElement>("checkbox", { name: "Viewed src/page.ts" }).checked,
    ).toBe(true),
  );
  await chooseCommit("All commits");
  await screen.findByText("current");
  expect(
    screen.getByRole<HTMLInputElement>("checkbox", { name: "Viewed src/page.ts" }).checked,
  ).toBe(false);
  expect(screen.getByRole("status", { name: "Annotation version" }).textContent).toBe(
    `${detail.baseSha}/${detail.status.headSha}/all`,
  );
  await chooseCommit(/Historical commit/);
  await screen.findByText("historical");
  expect(
    screen.getByRole<HTMLInputElement>("checkbox", { name: "Viewed src/page.ts" }).checked,
  ).toBe(true);
});
