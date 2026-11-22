// @vitest-environment jsdom
import { ClientProvider } from "@ace/client-react";
import { FakeDaemon } from "@ace/fake-daemon";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { formatRelativeWords, type CommitDiffTarget } from "@/lib/git-history.ts";
import { fakeClient } from "@/test/fake-client.ts";
import { EditorCommitCompare } from "./editor-commit-compare.tsx";
import { EditorTimeline } from "./editor-timeline.tsx";

afterEach(cleanup);

const threadId = "thread-timeline";
const nowMs = 1_700_000_000_000;
const sha1 = "1".repeat(40);
const sha2 = "2".repeat(40);

const samplePatch = [
  "diff --git a/src/app.ts b/src/app.ts",
  "index 1111111..2222222 100644",
  "--- a/src/app.ts",
  "+++ b/src/app.ts",
  "@@ -1,2 +1,2 @@",
  "-export const version = 1;",
  "+export const version = 2;",
  " export const ready = true;",
  "",
].join("\n");

function TimelineHarness(props: { path: string }) {
  const [target, setTarget] = useState<CommitDiffTarget | undefined>(undefined);
  return (
    <div>
      <EditorTimeline
        threadId={threadId}
        path={props.path}
        open
        onOpenChange={() => {}}
        activeCommitSha={target?.sha}
        onOpenCommit={setTarget}
        now={() => nowMs}
      />
      {target && (
        <EditorCommitCompare
          threadId={threadId}
          target={target}
          onClose={() => setTarget(undefined)}
          now={() => nowMs}
        />
      )}
    </div>
  );
}

function pagedCommit(index: number, subject: string) {
  return {
    sha: index.toString(16).padStart(40, "0"),
    shortSha: index.toString(16).padStart(7, "0"),
    subject,
    authorName: "Arpan",
    authorEmail: "arpan@example.invalid",
    authoredAt: nowMs - (index + 1) * 3600_000,
    path: "src/paged.ts",
  };
}

describe("EditorTimeline and EditorCommitCompare", () => {
  test("lists file history, copies commit id, and opens a read-only commit diff on click", async () => {
    const daemon = new FakeDaemon({ clock: () => nowMs });
    daemon.workspace.setGitLog(threadId, "src/app.ts", [
      {
        sha: sha1,
        shortSha: sha1.slice(0, 7),
        subject: "Bump version to 2",
        authorName: "Arpan",
        authorEmail: "arpan@example.invalid",
        authoredAt: nowMs - 3 * 24 * 60 * 60 * 1000,
        path: "src/app.ts",
      },
      {
        sha: sha2,
        shortSha: sha2.slice(0, 7),
        subject: "Initial commit",
        authorName: "Spade",
        authorEmail: "spade@example.invalid",
        authoredAt: nowMs - 10 * 24 * 60 * 60 * 1000,
        path: "src/app.ts",
      },
    ]);
    daemon.workspace.setGitCommitDiff(threadId, sha1, samplePatch);

    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });

    const client = fakeClient(daemon);
    await client.start();
    await waitFor(() => expect(client.state).toBe("ready"));

    render(
      <ClientProvider client={client}>
        <TimelineHarness path="src/app.ts" />
      </ClientProvider>,
    );

    // Lists entries from git.log with subject, author, and relative time.
    const latest = await screen.findByRole("button", { name: /Bump version to 2/ });
    expect(latest.textContent).toContain("Arpan");
    expect(latest.textContent).toContain("3 days ago");
    expect(screen.getByRole("button", { name: /Initial commit/ })).toBeTruthy();

    // Copy commit id copies the full SHA.
    fireEvent.click(screen.getByRole("button", { name: `Copy commit id ${sha1.slice(0, 7)}` }));
    expect(writeText).toHaveBeenCalledWith(sha1);

    // Clicking a timeline entry opens the read-only commit diff from commit-scoped git.diff.
    fireEvent.click(latest);
    const diffRegion = await screen.findByRole("region", {
      name: `Changes in ${sha1.slice(0, 7)} for src/app.ts`,
    });
    expect(diffRegion).toBeTruthy();
    await waitFor(() => {
      expect(diffRegion.textContent).toContain("export const version = 2;");
    });

    // Closing the diff returns to the normal view.
    fireEvent.click(screen.getByRole("button", { name: "Close commit diff" }));
    expect(
      screen.queryByRole("region", { name: `Changes in ${sha1.slice(0, 7)} for src/app.ts` }),
    ).toBeNull();
  });

  test("a commit that also touched the file it came from shows this file's change", async () => {
    const daemon = new FakeDaemon({ clock: () => nowMs });
    daemon.workspace.setGitLog(threadId, "src/app.ts", [
      {
        sha: sha1,
        shortSha: sha1.slice(0, 7),
        subject: "Move the model into app",
        authorName: "Arpan",
        authorEmail: "arpan@example.invalid",
        authoredAt: nowMs - 60_000,
        path: "src/app.ts",
        previousPath: "src/old.ts",
      },
    ]);
    const fromFirst = [
      "diff --git a/src/old.ts b/src/old.ts",
      "index 3333333..4444444 100644",
      "--- a/src/old.ts",
      "+++ b/src/old.ts",
      "@@ -1 +1 @@",
      "-export const model = 1;",
      '+export * from "./app.ts";',
      "",
    ].join("\n");
    daemon.workspace.setGitCommitDiff(threadId, sha1, fromFirst + samplePatch);
    const client = fakeClient(daemon);
    await client.start();
    await waitFor(() => expect(client.state).toBe("ready"));
    render(
      <ClientProvider client={client}>
        <TimelineHarness path="src/app.ts" />
      </ClientProvider>,
    );

    fireEvent.click(await screen.findByRole("button", { name: /Move the model into app/ }));
    const diffRegion = await screen.findByRole("region", {
      name: `Changes in ${sha1.slice(0, 7)} for src/app.ts`,
    });
    await waitFor(() => expect(diffRegion.textContent).toContain("export const version = 2;"));
    expect(diffRegion.textContent).not.toContain("export const model = 1;");
  });

  test("a capped patch that holds only the source file says the change is not available", async () => {
    const daemon = new FakeDaemon({ clock: () => nowMs });
    daemon.workspace.setGitLog(threadId, "src/app.ts", [
      {
        sha: sha1,
        shortSha: sha1.slice(0, 7),
        subject: "Copy the model into app",
        authorName: "Arpan",
        authorEmail: "arpan@example.invalid",
        authoredAt: nowMs - 60_000,
        path: "src/app.ts",
        previousPath: "src/old.ts",
      },
    ]);
    daemon.workspace.setGitCommitDiff(
      threadId,
      sha1,
      [
        "diff --git a/src/old.ts b/src/old.ts",
        "index 3333333..4444444 100644",
        "--- a/src/old.ts",
        "+++ b/src/old.ts",
        "@@ -1 +1 @@",
        "-export const model = 1;",
        "+export const model = 2;",
        "",
      ].join("\n"),
    );
    const client = fakeClient(daemon);
    await client.start();
    await waitFor(() => expect(client.state).toBe("ready"));
    render(
      <ClientProvider client={client}>
        <TimelineHarness path="src/app.ts" />
      </ClientProvider>,
    );

    fireEvent.click(await screen.findByRole("button", { name: /Copy the model into app/ }));
    const diffRegion = await screen.findByRole("region", {
      name: `Changes in ${sha1.slice(0, 7)} for src/app.ts`,
    });
    await waitFor(() =>
      expect(diffRegion.textContent).toContain(
        "This commit's change to src/app.ts isn't available",
      ),
    );
    expect(diffRegion.textContent).not.toContain("export const model");
  });

  test("a long history lists the newest 200 commits and says older ones are in git log", async () => {
    const daemon = new FakeDaemon({ clock: () => nowMs });
    daemon.workspace.setGitLog(
      threadId,
      "src/paged.ts",
      Array.from({ length: 250 }, (_, index) => pagedCommit(index, `Commit #${index + 1}`)),
    );
    const client = fakeClient(daemon);
    await client.start();
    await waitFor(() => expect(client.state).toBe("ready"));
    render(
      <ClientProvider client={client}>
        <EditorTimeline
          threadId={threadId}
          path="src/paged.ts"
          open
          onOpenChange={() => {}}
          onOpenCommit={() => {}}
          now={() => nowMs}
        />
      </ClientProvider>,
    );

    await screen.findByText("Commit #1");
    expect(screen.getByText("Commit #200")).toBeTruthy();
    expect(screen.queryByText("Commit #201")).toBeNull();
    expect(screen.getByText("Older history is in git log.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
  });

  test("a walk that ran out of time says it stopped early", async () => {
    const daemon = new FakeDaemon({ clock: () => nowMs });
    daemon.workspace.setGitLog(
      threadId,
      "src/paged.ts",
      [pagedCommit(0, "Only one in time")],
      "budget",
    );
    const client = fakeClient(daemon);
    await client.start();
    await waitFor(() => expect(client.state).toBe("ready"));
    render(
      <ClientProvider client={client}>
        <EditorTimeline
          threadId={threadId}
          path="src/paged.ts"
          open
          onOpenChange={() => {}}
          onOpenCommit={() => {}}
          now={() => nowMs}
        />
      </ClientProvider>,
    );
    await screen.findByText("Only one in time");
    expect(screen.getByText("Stopped early: history is very long.")).toBeTruthy();
    expect(screen.queryByText("Older history is in git log.")).toBeNull();
  });
});

describe("formatRelativeWords", () => {
  test.each([
    { deltaMs: 10_000, expected: "just now" },
    { deltaMs: 60_000, expected: "1 minute ago" },
    { deltaMs: 5 * 60_000, expected: "5 minutes ago" },
    { deltaMs: 2 * 3_600_000, expected: "2 hours ago" },
    { deltaMs: 3 * 86_400_000, expected: "3 days ago" },
    { deltaMs: 21 * 86_400_000, expected: "3 weeks ago" },
    { deltaMs: 90 * 86_400_000, expected: "3 months ago" },
    { deltaMs: 730 * 86_400_000, expected: "2 years ago" },
  ])("formats $deltaMs ms as $expected", ({ deltaMs, expected }) => {
    expect(formatRelativeWords(nowMs - deltaMs, nowMs)).toBe(expected);
  });
});
