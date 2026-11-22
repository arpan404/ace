// @vitest-environment jsdom
import { ClientProvider } from "@ace/client-react";
import { FakeDaemon } from "@ace/fake-daemon";
import type { LineMark } from "@ace/ui-core";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  createStatusStore,
  type StatusReport,
  type TextBuffer,
} from "@/features/editor-workbench/index.ts";
import { defaultEditorPreferences } from "@/lib/editor-preferences.ts";
import { fakeClient } from "@/test/fake-client.ts";
import type { AgentBlock } from "./agent-lines.ts";
import { clearInlineBlameCache, useInlineBlame } from "./use-inline-blame.tsx";

afterEach(() => {
  cleanup();
  clearInlineBlameCache();
});

const threadId = "thread-blame";
const nowMs = 1_700_000_000_000;
const headSha = "b".repeat(40);
const nextHeadSha = "c".repeat(40);

function makeFakeBuffer(path: string, initialVersion = "v1") {
  let version = initialVersion;
  const listeners = new Set<() => void>();
  const buffer: TextBuffer = {
    key: { root: threadId, path },
    document: () => undefined,
    view: () => undefined,
    snapshot: () => ({
      path,
      status: { kind: "ready" },
      dirty: false,
      saving: false,
      clash: undefined,
      draftKept: false,
      manualSave: false,
      version,
    }),
    baseText: () => "",
    subscribe: (listener) => {
      const wrap = () => listener({ type: "state" });
      listeners.add(wrap);
      return () => void listeners.delete(wrap);
    },
    edited: () => {
      // Typing emits buffer events without changing disk version.
      for (const listener of listeners) listener();
    },
    editLines: () => false,
    save: async () => ({ kind: "saved", version }),
    replace: async () => ({ kind: "saved", version }),
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
    bumpDiskVersion(next: string) {
      version = next;
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
  head: string | undefined;
  statusStore: ReturnType<typeof createStatusStore>;
  agentBlocks?: readonly AgentBlock[];
  marks?: ReadonlyMap<number, LineMark>;
  onOpenCommit?: (target: { sha: string; path: string }) => void;
}) {
  const { onVisibleRange, caretAnnotation } = useInlineBlame({
    enabled: props.enabled,
    threadId,
    path: "src/app.ts",
    group: "g1",
    buffer: props.buffer,
    head: props.head,
    agentBlocks: props.agentBlocks ?? [],
    marks: props.marks,
    statusStore: props.statusStore,
    onOpenCommit: props.onOpenCommit,
    now: () => nowMs,
  });

  useEffect(() => {
    onVisibleRange({ firstLine: 1, lastLine: 20, lineCount: 20 });
  }, [onVisibleRange]);

  return (
    <div data-testid="caret-line" data-line={caretAnnotation?.line ?? ""}>
      {caretAnnotation?.content ?? null}
    </div>
  );
}

describe("Inline git blame", () => {
  test("is off by default and makes no git.blame requests while disabled", async () => {
    expect(defaultEditorPreferences.inlineBlame).toBe(false);

    const daemon = new FakeDaemon({ clock: () => nowMs });
    const client = fakeClient(daemon);
    const spy = vi.spyOn(client, "request");
    await client.start();
    await waitFor(() => expect(client.state).toBe("ready"));

    const { buffer } = makeFakeBuffer("src/app.ts");
    const statusStore = createStatusStore();
    statusStore.report("g1", statusAt(1));

    render(
      <ClientProvider client={client}>
        <BlameProbe enabled={false} buffer={buffer} head={headSha} statusStore={statusStore} />
      </ClientProvider>,
    );

    expect(screen.getByTestId("caret-line").textContent).toBe("");
    const blameCalls = spy.mock.calls.filter(
      ([req]) => req.type === "workspace.request" && req.operation.op === "git.blame",
    );
    expect(blameCalls).toHaveLength(0);
  });

  test("shows committed, uncommitted, and agent lines on the caret line, caches across keystrokes, and recomputes on save or HEAD change", async () => {
    const daemon = new FakeDaemon({ clock: () => nowMs });
    daemon.workspace.setGitBlame(threadId, "src/app.ts", {
      commits: [
        {
          sha: headSha,
          shortSha: headSha.slice(0, 7),
          subject: "Wire inline blame",
          authorName: "Arpan",
          authorEmail: "arpan@example.invalid",
          authoredAt: nowMs - 3 * 86_400_000,
        },
      ],
      lines: [
        { line: 1, sha: headSha },
        { line: 2, sha: null },
        { line: 3, sha: headSha },
      ],
      capped: false,
    });

    const client = fakeClient(daemon);
    const spy = vi.spyOn(client, "request");
    await client.start();
    await waitFor(() => expect(client.state).toBe("ready"));

    const { buffer, bumpDiskVersion } = makeFakeBuffer("src/app.ts", "v1");
    const statusStore = createStatusStore();
    statusStore.report("g1", statusAt(1));
    const onOpenCommit = vi.fn();
    const agentBlocks: AgentBlock[] = [
      { start: 2, end: 3, who: { name: "Claude Code", turn: 4 }, at: nowMs - 60_000 },
    ];

    const view = render(
      <ClientProvider client={client}>
        <BlameProbe
          enabled
          buffer={buffer}
          head={headSha}
          statusStore={statusStore}
          agentBlocks={agentBlocks}
          onOpenCommit={onOpenCommit}
        />
      </ClientProvider>,
    );

    const committed = await screen.findByRole("button", {
      name: "Arpan, 3 days ago · Wire inline blame",
    });
    expect(committed).toBeTruthy();

    const blameCallCount = () =>
      spy.mock.calls.filter(
        ([req]) => req.type === "workspace.request" && req.operation.op === "git.blame",
      ).length;
    expect(blameCallCount()).toBe(1);

    // Typing keystrokes (buffer edits without disk version change) must NOT re-fetch git.blame.
    act(() => {
      buffer.edited();
      buffer.edited();
    });
    expect(blameCallCount()).toBe(1);

    // Caret moving to an uncommitted line says "You · not committed yet" without another request.
    act(() => statusStore.report("g1", statusAt(2)));
    expect(screen.getByText("You · not committed yet")).toBeTruthy();
    expect(blameCallCount()).toBe(1);

    // Caret moving to an agent-authored line says the agent's name.
    act(() => statusStore.report("g1", statusAt(3)));
    expect(screen.getByText("Claude Code, 1 minute ago · turn 4")).toBeTruthy();
    expect(blameCallCount()).toBe(1);

    // Saving (disk version changes) recomputes blame for the visible range.
    act(() => bumpDiskVersion("v2"));
    await waitFor(() => expect(blameCallCount()).toBe(2));

    // A HEAD change also recomputes blame for the visible range.
    view.rerender(
      <ClientProvider client={client}>
        <BlameProbe
          enabled
          buffer={buffer}
          head={nextHeadSha}
          statusStore={statusStore}
          agentBlocks={agentBlocks}
          onOpenCommit={onOpenCommit}
        />
      </ClientProvider>,
    );
    await waitFor(() => expect(blameCallCount()).toBe(3));

    // Clicking/hovering a committed annotation opens the commit card with "Open changes".
    act(() => statusStore.report("g1", statusAt(1)));
    const trigger = await screen.findByRole("button", {
      name: "Arpan, 3 days ago · Wire inline blame",
    });
    fireEvent.mouseEnter(trigger);
    fireEvent.focus(trigger);
    const openBtn = await screen.findByRole("button", { name: "Open changes" });
    fireEvent.click(openBtn);
    expect(onOpenCommit).toHaveBeenCalledWith(
      expect.objectContaining({ sha: headSha, path: "src/app.ts" }),
    );
  });
});
