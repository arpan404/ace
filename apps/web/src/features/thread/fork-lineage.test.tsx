import { bringBackWaits } from "@ace/ui-core";
import { longHistory } from "@ace/fake-daemon";
import { ThreadId } from "@ace/protocol";
import { configure, screen, within } from "@testing-library/react";

import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";
import { chooseSource } from "@/test/model-control.ts";
import { harness } from "@/test/harness.tsx";
import { openWorkCard } from "@/test/open-work.ts";

configure({ asyncUtilTimeout: 10000 });

beforeEach(() => localStorage.clear());

const banner = () => within(screen.getByRole("banner"));

/** Whether `first` comes before `second` in the document, as it reads. */
const precedes = (first: Node, second: Node) =>
  Boolean(first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING);

async function fork() {
  const app = harness();
  app.play(longHistory(2)).runUntilBlocked();
  await app.open("/t/thread-router");
  await screen.findByRole("feed", { name: "Transcript" });
  await userEvent.keyboard("{Meta>}k{/Meta}");
  await userEvent.type(
    await screen.findByRole("combobox", { name: "Search commands" }, { timeout: 10000 }),
    "Fork",
  );
  await userEvent.click(await screen.findByRole("option", { name: /Fork from the last turn/ }));
  // The fork opens as a thread of its own, ready for its first message.
  await screen.findByRole("heading", { name: "Document the router (fork)", level: 1 });
  await userEvent.click(await screen.findByRole("button", { name: /^Fork model:/ }));
  const picker = await screen.findByRole("dialog", { name: "Fork model" });
  await chooseSource(picker, "Codex · Personal");
  await userEvent.type(
    within(picker).getByRole("combobox", { name: "Search models" }),
    "GPT-5 Codex",
  );
  await userEvent.click(
    await within(picker).findByRole("option", { name: /^GPT-5 Codex, Codex · Personal$/ }),
  );
  await userEvent.type(
    await screen.findByRole("combobox", { name: "Message" }),
    "Try the simpler approach{Enter}",
  );
  await within(await screen.findByRole("feed", { name: "Transcript" })).findByText(
    "Try the simpler approach",
  );
  const view = app.daemon.snapshot({ kind: "threads" });
  const child =
    view?.kind === "threads"
      ? Object.values(view.threads).find((thread) => thread.lineage)
      : undefined;
  if (!child) throw new Error("No fork created");
  return { app, child };
}

function finish(app: ReturnType<typeof harness>, id: string) {
  const view = app.daemon.snapshot({ kind: "thread", threadId: ThreadId.parse(id) });
  const run =
    view?.kind === "thread"
      ? Object.values(view.runs).find((candidate) => candidate.state === "active")
      : undefined;
  if (!run?.nativeId) throw new Error("No running fork");
  app.daemon.apply(id, [
    {
      type: "item.upsert",
      agent: "root",
      item: "reading",
      draft: {
        type: "message",
        role: "assistant",
        complete: true,
        parts: [{ type: "text", text: "Use a single route table." }],
      },
    },
    { type: "turn.ended", agent: "root", nativeTurnId: run.nativeId, outcome: "completed" },
  ]);
}

async function openMerge() {
  await userEvent.keyboard("{Meta>}k{/Meta}");
  await userEvent.type(
    await screen.findByRole("combobox", { name: "Search commands" }, { timeout: 10000 }),
    "Bring back",
  );
  await userEvent.click(await screen.findByRole("option", { name: /Bring back to parent/ }));
  return screen.findByRole("dialog", { name: "Bring back to parent" });
}

const transcript = () => within(screen.getByRole("feed", { name: "Transcript" }));
/** The transcript's "Forked from <source>" divider. */
async function forkMarker() {
  const notes = await transcript().findAllByRole("note");
  const marker = notes.find((note) => note.textContent?.startsWith("Forked from"));
  if (!marker) throw new Error("No Forked from divider");
  return marker;
}

test("a fork runs on the model picked before its first message, and the source keeps its own state", async () => {
  const { app, child } = await fork();
  expect(child.provider).toBe("codex");
  expect(child.execution?.model).toBe("gpt-5-codex");
  expect(child.execution?.instanceId).toBe("codex-personal");
  expect(await screen.findByRole("button", { name: /^Model: GPT-5 Codex/ })).toBeTruthy();
  const view = app.daemon.snapshot({ kind: "thread", threadId: ThreadId.parse("thread-router") });
  expect(view?.kind === "thread" && view.thread.status.state).toBe("done");
});

test("a fork's transcript shows the conversation it continues, then where it was forked from, then its own", async () => {
  await fork();
  const feed = transcript();
  const ask = await feed.findByText("Question 1: what does route 1 render?");
  const answer = feed.getByText("Answer 2: route 2 renders its own panel.");
  const marker = await forkMarker();
  const source = within(marker).getByRole("link", { name: "Document the router" });
  expect(marker.textContent).toContain("Forked from");
  const own = feed.getByText("Try the simpler approach");
  expect(precedes(ask, answer) && precedes(answer, marker) && precedes(marker, own)).toBe(true);
  // Each copied message shows once.
  expect(feed.getAllByText("Question 2: what does route 2 render?")).toHaveLength(1);
  await userEvent.click(source);
  await screen.findByRole("heading", { level: 1, name: "Document the router" });
});

test("a fork's header names its project like any thread, never the thread it came from", async () => {
  await fork();
  const forkTitle = await banner().findByRole("heading", {
    level: 1,
    name: "Document the router (fork)",
  });
  const project = banner().getByText("docs-site");
  expect(precedes(project, forkTitle)).toBe(true);
  expect(banner().queryByRole("link", { name: "Document the router" })).toBeNull();
});

test("a fork is no one's agent: neither it nor its source lists the other under Agents", async () => {
  await fork();
  expect(within(await openWorkCard()).queryByRole("region", { name: "Agents" })).toBeNull();
  await userEvent.keyboard("{Escape}");
  await userEvent.click(
    within(await forkMarker()).getByRole("link", { name: "Document the router" }),
  );
  await screen.findByRole("heading", { level: 1, name: "Document the router" });
  expect(within(await openWorkCard()).queryByRole("region", { name: "Agents" })).toBeNull();
});

test("bringing a summary and code changes back shows the fork's name and edited summary in the parent", async () => {
  const { app, child } = await fork();
  finish(app, child.id);
  app.daemon.workspace.setGitDiff(
    child.id,
    "diff --git a/file.txt b/file.txt\n--- a/file.txt\n+++ b/file.txt\n@@ -1 +1 @@\n-before\n+after\n",
  );
  const dialog = await openMerge();
  const summary = within(dialog).getByRole<HTMLTextAreaElement>("textbox", { name: "Summary" });
  expect(summary.value).toBe("Use a single route table.");
  await userEvent.clear(summary);
  await userEvent.type(summary, "One table is easier to maintain.");
  await userEvent.click(within(dialog).getByRole("checkbox", { name: "Include code changes" }));
  await userEvent.click(within(dialog).getByRole("button", { name: "Bring back" }));
  await screen.findByRole("heading", { level: 1, name: "Document the router" });
  expect(await screen.findByText("Merged from", { exact: false })).toBeTruthy();
  expect(screen.getByRole("link", { name: "Document the router (fork)" })).toBeTruthy();
  expect(screen.getByText("· Code changes included")).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "Show summary" }));
  expect(await screen.findByText("One table is easier to maintain.")).toBeTruthy();
});

test("a running fork can't be brought back: the summary stays editable and the dialog says why", async () => {
  const { app, child } = await fork();
  finish(app, child.id);
  const dialog = await openMerge();
  app.daemon.apply(child.id, [
    { type: "turn.started", agent: "root", nativeTurnId: "background", trigger: "unknown" },
  ]);
  expect((await within(dialog).findByRole("status")).textContent).toBe(bringBackWaits.working);
  expect(
    within(dialog).getByRole<HTMLButtonElement>("button", { name: "Bring back" }).disabled,
  ).toBe(true);
  expect(within(dialog).getByRole<HTMLTextAreaElement>("textbox", { name: "Summary" }).value).toBe(
    "Use a single route table.",
  );
});

test("including an oversized patch explains how to bring back the summary instead", async () => {
  const { app, child } = await fork();
  finish(app, child.id);
  app.daemon.workspace.setGitDiff(child.id, "x".repeat(65537));
  const dialog = await openMerge();
  await userEvent.click(within(dialog).getByRole("checkbox", { name: "Include code changes" }));
  await userEvent.click(within(dialog).getByRole("button", { name: "Bring back" }));
  expect((await within(dialog).findByRole("alert")).textContent).toContain("too large");
  await userEvent.click(within(dialog).getByRole("checkbox", { name: "Include code changes" }));
  await userEvent.click(within(dialog).getByRole("button", { name: "Bring back" }));
  await screen.findByRole("heading", { name: "Document the router", level: 1 });
  expect(await screen.findByText("Merged from", { exact: false })).toBeTruthy();
  expect(screen.queryByText("· Code changes included")).toBeNull();
});
