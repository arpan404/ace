import { longHistory } from "@ace/fake-daemon";
import { ThreadId } from "@ace/protocol";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";
import { selectAccount } from "@/test/model-control.ts";
import { harness } from "@/test/harness.tsx";

beforeEach(() => localStorage.clear());

async function fork() {
  const app = harness();
  app.play(longHistory(2)).runUntilBlocked();
  await app.open("/t/thread-router");
  await screen.findByRole("feed", { name: "Transcript" });
  await userEvent.keyboard("{Meta>}k{/Meta}");
  await userEvent.type(await screen.findByRole("combobox", { name: "Search commands" }, { timeout: 10000 }), "Fork");
  await userEvent.click(await screen.findByRole("option", { name: /Fork from the last turn/ }));
  const dialog = await screen.findByRole("dialog", { name: "Fork from here" });
  const title = within(dialog).getByRole("textbox", { name: "Title" });
  await userEvent.clear(title);
  await userEvent.type(title, "Try another model");
  await userEvent.click(within(dialog).getByRole("button", { name: /^Fork model:/ }));
  const picker = await screen.findByRole("dialog", { name: "Fork model" });
  await userEvent.click(await within(picker).findByRole("tab", { name: "Codex" }));
  await selectAccount(picker, "Personal");
  await userEvent.type(
    within(picker).getByRole("combobox", { name: "Search models" }),
    "GPT-5 Codex",
  );
  await userEvent.click(
    await within(picker).findByRole("option", { name: /^GPT-5 Codex,.*Codex/ }),
  );
  await userEvent.type(
    within(dialog).getByRole("textbox", { name: "First message of the fork" }),
    "Try the simpler approach",
  );
  await userEvent.click(within(dialog).getByRole("button", { name: "Fork" }));
  await screen.findByRole("heading", { name: "Try another model", level: 1 });
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
  await userEvent.click(screen.getByRole("button", { name: "More actions" }));
  await userEvent.click(await screen.findByRole("menuitem", { name: "Bring back to parent…" }));
  return screen.findByRole("dialog", { name: "Bring back to parent" });
}

test("a named fork runs on the chosen model and links back to its parent", async () => {
  const { app, child } = await fork();
  expect(child.provider).toBe("codex");
  expect(child.execution?.model).toBe("gpt-5-codex");
  expect(child.execution?.instanceId).toBe("codex-personal");
  expect(await screen.findByRole("button", { name: /^Model: GPT-5 Codex/ })).toBeTruthy();
  const parent = screen.getByRole("link", { name: "Document the router" });
  await userEvent.click(parent);
  await screen.findByRole("heading", { level: 1, name: "Document the router" });
  expect(screen.queryByText("Forked from")).toBeNull();
  const view = app.daemon.snapshot({ kind: "thread", threadId: ThreadId.parse("thread-router") });
  expect(view?.kind === "thread" && view.thread.status.state).toBe("done");
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
  expect(screen.getByRole("link", { name: "Try another model" })).toBeTruthy();
  expect(screen.getByText("· Code changes included")).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "Show summary" }));
  expect(await screen.findByText("One table is easier to maintain.")).toBeTruthy();
});

test("bringing back a running fork keeps the summary editable and explains why it must wait", async () => {
  const { app, child } = await fork();
  finish(app, child.id);
  const dialog = await openMerge();
  app.daemon.apply(child.id, [
    { type: "turn.started", agent: "root", nativeTurnId: "background", trigger: "unknown" },
  ]);
  await userEvent.click(within(dialog).getByRole("button", { name: "Bring back" }));
  expect((await within(dialog).findByRole("alert")).textContent).toContain(
    "Wait for all agents in the fork to finish",
  );
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
