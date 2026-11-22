// @vitest-environment jsdom
import { ClientProvider } from "@ace/client-react";
import type { EditorDocument } from "@ace/editor";
import { FakeDaemon } from "@ace/fake-daemon";
import type { GitBlameCommit } from "@ace/protocol";
import { hunksFromChanges, type WholeLineChange } from "@ace/ui-core";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  createStatusStore,
  noteBufferEdited,
  type StatusReport,
  type TextBuffer,
} from "@/features/editor-workbench/index.ts";
import { defaultEditorPreferences } from "@/lib/editor-preferences.ts";
import { fakeClient } from "@/test/fake-client.ts";
import type { AgentBlock } from "./agent-lines.ts";
import type { GutterState } from "./live-gutter.ts";
import {
  clearInlineBlameCache,
  heldBlameLines,
  maxChunksPerFile,
  useInlineBlame,
  type BlameGutter,
} from "./use-inline-blame.tsx";

afterEach(() => {
  cleanup();
  clearInlineBlameCache();
});

const threadId = "thread-blame";
const path = "src/app.ts";
const nowMs = 1_700_000_000_000;
const headSha = "b".repeat(40);
const nextHeadSha = "c".repeat(40);
const olderSha = "d".repeat(40);

function author(sha: string, name: string, subject: string): GitBlameCommit {
  return {
    sha,
    shortSha: sha.slice(0, 7),
    subject,
    authorName: name,
    authorEmail: `${name.toLowerCase()}@example.invalid`,
    authoredAt: nowMs - 3 * 86_400_000,
  };
}

/** A buffer whose document's version moves as the person types. */
function fakeBuffer() {
  let version = 1;
  const doc = { version: () => version };
  const buffer: TextBuffer = {
    key: { root: threadId, path },
    document: () => doc as unknown as EditorDocument,
    view: () => undefined,
    snapshot: () => ({
      path,
      status: { kind: "ready" },
      dirty: false,
      saving: false,
      clash: undefined,
      draftKept: false,
      manualSave: false,
      version: "v1",
    }),
    baseText: () => "",
    subscribe: () => () => {},
    edited: () => {},
    editLines: () => false,
    save: async () => ({ kind: "saved", version: "v1" }),
    replace: async () => ({ kind: "saved", version: "v1" }),
    merge: async () => {},
    keepMine: async () => {},
    takeTheirs: async () => {},
    answer: async () => {},
    answerAll: async () => {},
    discard: async () => {},
    saveStamp: () => undefined,
    reload: async () => {},
  };
  return {
    buffer,
    doc,
    type() {
      version++;
      noteBufferEdited(buffer);
    },
  };
}

/** The live gutter as blame reads it: hunks worked out on the document at its version. */
function fakeGutter(doc: { version(): number }) {
  const listeners = new Set<() => void>();
  let state: GutterState = { hunks: [], marks: undefined, agent: [] };
  const gutter: BlameGutter = {
    state: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
  return {
    gutter,
    /** The gutter worked the hunks out again on the text as it is now. */
    settle(
      lines: readonly string[],
      changes: readonly WholeLineChange[],
      agent: AgentBlock[] = [],
      commit: string = headSha,
    ) {
      state = {
        hunks: hunksFromChanges(changes, (line) => lines[line] ?? "", lines.length),
        marks: undefined,
        agent,
        basis: {
          doc: doc as unknown as EditorDocument,
          version: doc.version(),
          head: "",
          generation: "",
          commit,
        },
      };
      for (const listener of listeners) listener();
    },
  };
}

function statusAt(line: number): StatusReport {
  return {
    status: {
      line,
      column: 1,
      selections: 1,
      selectedCharacters: 0,
      selectedLines: 0,
      indent: { tabs: false, size: 2 },
      lineEnding: "\n",
      encoding: "UTF-8",
      language: "typescript",
      languageChosen: false,
      whitespace: false,
      readOnly: false,
    },
    actions: {
      setIndent: () => {},
      setLineEnding: () => {},
      setLanguage: () => {},
      setWhitespace: () => {},
    },
  };
}

function BlameProbe(props: {
  enabled: boolean;
  buffer: TextBuffer;
  commit: string | undefined;
  gutter: BlameGutter;
  statusStore: ReturnType<typeof createStatusStore>;
  first?: number;
  onOpenCommit?: (target: { sha: string; path: string }) => void;
}) {
  const { onVisibleRange, caretAnnotation } = useInlineBlame({
    enabled: props.enabled,
    threadId,
    path,
    group: "g1",
    buffer: props.buffer,
    commit: props.commit,
    gutter: props.gutter,
    statusStore: props.statusStore,
    onOpenCommit: props.onOpenCommit,
    now: () => nowMs,
  });
  const first = props.first ?? 1;
  useEffect(() => {
    onVisibleRange({ firstLine: first, lastLine: first + 19, lineCount: first + 19 });
  }, [onVisibleRange, first]);
  return <div data-testid="caret-line">{caretAnnotation?.content ?? null}</div>;
}

async function connected(daemon: FakeDaemon) {
  const client = fakeClient(daemon);
  const spy = vi.spyOn(client, "request");
  await client.start();
  await waitFor(() => expect(client.state).toBe("ready"));
  const blameRequests = () =>
    spy.mock.calls.flatMap(([req]) =>
      req.type === "workspace.request" && req.operation.op === "git.blame" ? [req.operation] : [],
    );
  return { client, blameRequests };
}

function setup() {
  const typing = fakeBuffer();
  const gutter = fakeGutter(typing.doc);
  const statusStore = createStatusStore();
  statusStore.report("g1", statusAt(1));
  return { typing, gutter, statusStore };
}

describe("Inline git blame", () => {
  test("is off by default and makes no git.blame requests while disabled", async () => {
    expect(defaultEditorPreferences.inlineBlame).toBe(false);
    const { client, blameRequests } = await connected(new FakeDaemon({ clock: () => nowMs }));
    const { typing, gutter, statusStore } = setup();

    render(
      <ClientProvider client={client}>
        <BlameProbe
          enabled={false}
          buffer={typing.buffer}
          commit={headSha}
          gutter={gutter.gutter}
          statusStore={statusStore}
        />
      </ClientProvider>,
    );

    expect(screen.getByTestId("caret-line").textContent).toBe("");
    expect(blameRequests()).toHaveLength(0);
  });

  test("a file git has no history for says it is not committed yet, after asking git", async () => {
    const { client, blameRequests } = await connected(new FakeDaemon({ clock: () => nowMs }));
    const { typing, gutter, statusStore } = setup();
    statusStore.report("g1", statusAt(3));

    render(
      <ClientProvider client={client}>
        <BlameProbe
          enabled
          buffer={typing.buffer}
          commit={headSha}
          gutter={gutter.gutter}
          statusStore={statusStore}
        />
      </ClientProvider>,
    );

    expect(await screen.findByText("You · not committed yet")).toBeTruthy();
    expect(blameRequests()).toEqual([
      expect.objectContaining({ path, commit: headSha, startLine: 1, endLine: 120 }),
    ]);
  });

  test("after an unsaved deletion the next line keeps its own author, never the deleted line's", async () => {
    const daemon = new FakeDaemon({ clock: () => nowMs });
    daemon.workspace.setGitBlame(threadId, path, {
      commits: [author(olderSha, "Robin", "First line"), author(headSha, "Sam", "Second line")],
      lines: [
        { line: 1, sha: olderSha },
        { line: 2, sha: headSha },
        { line: 3, sha: headSha },
      ],
    });
    const { client, blameRequests } = await connected(daemon);
    const { typing, gutter, statusStore } = setup();
    gutter.settle(["first", "second", "third"], []);

    render(
      <ClientProvider client={client}>
        <BlameProbe
          enabled
          buffer={typing.buffer}
          commit={headSha}
          gutter={gutter.gutter}
          statusStore={statusStore}
        />
      </ClientProvider>,
    );
    expect(
      await screen.findByRole("button", { name: "Robin, 3 days ago · First line" }),
    ).toBeTruthy();

    // The person deletes line 1 without saving: until the gutter has caught up nothing is said.
    act(() => typing.type());
    expect(screen.getByTestId("caret-line").textContent).toBe("");
    // The gutter's hunks now say committed line 1 was removed: editor line 1 is committed line 2.
    act(() => gutter.settle(["second", "third"], [{ start: 0, end: 0, text: "first\n" }]));
    expect(screen.getByRole("button", { name: "Sam, 3 days ago · Second line" })).toBeTruthy();

    // A line typed in its place (unsaved) is not committed yet.
    act(() => typing.type());
    act(() => gutter.settle(["new", "second", "third"], [{ start: 0, end: 1, text: "first\n" }]));
    expect(screen.getByText("You · not committed yet")).toBeTruthy();
    // Typing never asks git again: the blame is of the commit, which does not change.
    expect(blameRequests()).toHaveLength(1);
  });

  test("lines an agent wrote say the agent's name", async () => {
    const daemon = new FakeDaemon({ clock: () => nowMs });
    daemon.workspace.setGitBlame(threadId, path, {
      commits: [author(headSha, "Sam", "Second line")],
      lines: [{ line: 1, sha: headSha }],
    });
    const { client } = await connected(daemon);
    const { typing, gutter, statusStore } = setup();
    gutter.settle(
      ["a"],
      [],
      [{ start: 0, end: 1, who: { name: "Builder", turn: 4 }, at: nowMs - 60_000 }],
    );
    render(
      <ClientProvider client={client}>
        <BlameProbe
          enabled
          buffer={typing.buffer}
          commit={headSha}
          gutter={gutter.gutter}
          statusStore={statusStore}
        />
      </ClientProvider>,
    );
    expect(await screen.findByText("Builder, 1 minute ago · turn 4")).toBeTruthy();
  });

  test("a new commit reads blame at that commit and shows its author", async () => {
    const daemon = new FakeDaemon({ clock: () => nowMs });
    daemon.workspace.setGitBlame(
      threadId,
      path,
      { commits: [author(headSha, "Sam", "Before")], lines: [{ line: 1, sha: headSha }] },
      headSha,
    );
    daemon.workspace.setGitBlame(
      threadId,
      path,
      { commits: [author(nextHeadSha, "Kai", "After")], lines: [{ line: 1, sha: nextHeadSha }] },
      nextHeadSha,
    );
    const { client, blameRequests } = await connected(daemon);
    const { typing, gutter, statusStore } = setup();
    const onOpenCommit = vi.fn();
    const probe = (commit: string) => (
      <ClientProvider client={client}>
        <BlameProbe
          enabled
          buffer={typing.buffer}
          commit={commit}
          gutter={gutter.gutter}
          statusStore={statusStore}
          onOpenCommit={onOpenCommit}
        />
      </ClientProvider>
    );
    gutter.settle(["line"], [], [], headSha);
    const view = render(probe(headSha));
    expect(await screen.findByRole("button", { name: "Sam, 3 days ago · Before" })).toBeTruthy();

    // HEAD moved, but the gutter's hunks are still against the old commit: nothing is said.
    view.rerender(probe(nextHeadSha));
    await waitFor(() =>
      expect(blameRequests().some((request) => request.commit === nextHeadSha)).toBe(false),
    );
    expect(screen.getByTestId("caret-line").textContent).toBe("");

    act(() => gutter.settle(["line"], [], [], nextHeadSha));
    const after = await screen.findByRole("button", { name: "Kai, 3 days ago · After" });
    expect(blameRequests().at(-1)).toEqual(
      expect.objectContaining({ commit: nextHeadSha, startLine: 1, endLine: 120 }),
    );

    // Hovering the annotation offers the commit's changes.
    fireEvent.mouseEnter(after);
    fireEvent.focus(after);
    fireEvent.click(await screen.findByRole("button", { name: "Open changes" }));
    expect(onOpenCommit).toHaveBeenCalledWith(expect.objectContaining({ sha: nextHeadSha, path }));
  });

  test("scrolling through a long file keeps a bounded number of blamed lines", async () => {
    const { client } = await connected(new FakeDaemon({ clock: () => nowMs }));
    const { typing, gutter, statusStore } = setup();
    const probe = (first: number) => (
      <ClientProvider client={client}>
        <BlameProbe
          enabled
          buffer={typing.buffer}
          commit={headSha}
          gutter={gutter.gutter}
          statusStore={statusStore}
          first={first}
        />
      </ClientProvider>
    );
    const view = render(probe(1));
    for (let chunk = 1; chunk <= maxChunksPerFile + 6; chunk++) {
      view.rerender(probe(chunk * 120 + 1));
      await waitFor(() =>
        expect(heldBlameLines(threadId, path, headSha)).toBe(
          Math.min(chunk + 1, maxChunksPerFile) * 120,
        ),
      );
    }
  });
});
