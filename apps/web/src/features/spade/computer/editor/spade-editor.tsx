import {
  discardTabs,
  focusedGroup,
  groupsOf,
  keepTab,
  parseLayout,
  storedLayout,
  type EditorLayout,
  type TabRef,
} from "@ace/ui-core/editor-workbench";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { ConfirmDialog, type Confirming } from "@/components/confirm-dialog.tsx";
import { Button } from "@/components/ui/button.tsx";
import { MenuItem } from "@/components/ui/menu.tsx";
import {
  BufferEditor,
  Editor,
  shownVersion,
  useEditorBuffers,
  useSnapshot,
  type BufferEditorProps,
  type EditorViewerProps,
  type SaveOutcome,
  type StatusNotice,
} from "@/features/editor-workbench/index.ts";
import { editorLineHeight, useEditorPreferences } from "@/lib/editor-preferences.ts";
import { groupIds } from "@/lib/workspace/index.ts";
import { useSpadeClient } from "../../spade-machine.tsx";
import { FileMediaView, mediaModeOf } from "../file-media-view.tsx";
import { spadeEditorRegistry } from "./spade-editor-registry.ts";

/*
 * A bot's files in ace's editor (docs/editor/workbench.md), kept light: tabs with previews,
 * splits, breadcrumbs, Markdown's Preview / Source, the status line, drafts kept on the device,
 * and Merge when the bot writes a file under the person's edits. No git: no change marks,
 * Timeline, source control or review. The layout is kept per bot on this device.
 */

/** The most panes beside the chat, as the code editor allows there. */
const paneCap = 4;

const fileName = (path: string) => path.split("/").at(-1) ?? path;

/** The layout of one bot's editor, kept on this device across visits. */
export function useSpadeEditorLayout(root: string) {
  const key = `ace.spade.editor:${root}`;
  const [layout, setLayout] = useState<EditorLayout>(() => {
    let stored: unknown;
    try {
      stored = JSON.parse(localStorage.getItem(key) ?? "null");
    } catch {
      stored = undefined;
    }
    return parseLayout(stored, "g1");
  });
  const latest = useRef(layout);
  useLayoutEffect(() => {
    latest.current = layout;
  }, [layout]);
  const change = useCallback(
    (next: EditorLayout) => {
      if (next === latest.current) return;
      latest.current = next;
      setLayout(next);
      try {
        localStorage.setItem(key, JSON.stringify(storedLayout(next, new Set())));
      } catch {
        // Storage full or off: the layout lasts as long as this visit.
      }
    },
    [key],
  );
  /** The layout as it is now, even between a change and its render. */
  const current = useCallback(() => latest.current, []);
  return { layout, change, current };
}

/** Why the last save didn't go, said in the status line. */
interface Problem {
  path: string;
  message: string;
  /** The bot changed the file since: Replace writes over the version shown (null: deleted). */
  over?: string | null | undefined;
  /** The bot deleted it: saving writes it again. */
  gone?: boolean | undefined;
}

export function SpadeEditor(props: {
  root: string;
  bot: { id: string; name: string };
  layout: EditorLayout;
  onLayoutChange(next: EditorLayout): void;
  current(): EditorLayout;
  /** The person may change the files now. */
  writable: boolean;
  /** "Show files", at the first strip's left while the explorer is put away. */
  explorerToggle?: ReactNode;
  onDownload(path: string): void;
}) {
  const { root, layout, onLayoutChange: change, current } = props;
  const registry = spadeEditorRegistry(useSpadeClient());
  const buffers = useEditorBuffers(registry, root, layout);
  const [problem, setProblem] = useState<Problem>();
  const [confirming, setConfirming] = useState<Confirming>();
  const focused = focusedGroup(layout).active;
  const snapshot = useSnapshot(buffers, focused);
  const [preferences] = useEditorPreferences();
  const look = useMemo(
    () => ({
      fontSize: preferences.fontSize,
      lineHeight: editorLineHeight(preferences),
      fontFamily: preferences.fontFamily,
      // The panel beside the chat is narrow: documents wrap there unless the person said not to.
      wordWrap: true,
      renderWhitespace: preferences.renderWhitespace,
      indentGuides: preferences.indentGuides,
      stickyScroll: false,
      cursorBlinking: preferences.cursorBlinking,
    }),
    [preferences],
  );

  // Typing in a preview keeps it (spec 10).
  const typedPreviews = useSyncExternalStore(buffers.subscribe, () =>
    groupsOf(layout)
      .flatMap((group) =>
        group.tabs
          .filter((tab) => tab.preview && buffers.snapshot(tab.path)?.dirty)
          .map((tab) => `${group.id}\u0000${tab.path}`),
      )
      .join("\n"),
  );
  useEffect(() => {
    if (!typedPreviews) return;
    let next = current();
    for (const each of typedPreviews.split("\n")) {
      const [group = "", path = ""] = each.split("\u0000");
      next = keepTab(next, { group, path });
    }
    change(next);
  }, [typedPreviews, change, current]);

  const settle = (path: string, outcome: SaveOutcome) => {
    if (outcome.kind === "saved" || outcome.kind === "unchanged") {
      setProblem((was) => (was?.path === path ? undefined : was));
      return;
    }
    if (outcome.kind === "clash") {
      const clash = buffers.buffer(path)?.snapshot().clash;
      const gone = clash?.kind === "deleted";
      setProblem({
        path,
        message: `${props.bot.name} ${gone ? "deleted" : "changed"} ${fileName(path)} since you opened it.`,
        over: clash ? shownVersion(clash) : undefined,
        gone,
      });
      return;
    }
    if (outcome.kind === "unanswered")
      setProblem({ path, message: `Answer each conflicting block in ${fileName(path)} first.` });
    if (outcome.kind === "failed") setProblem({ path, message: outcome.message });
  };
  const save = async (path: string | undefined) => {
    const buffer = path === undefined ? undefined : buffers.buffer(path);
    if (!buffer || path === undefined) return;
    settle(path, await buffer.save("person"));
  };
  /** Writes the person's text over the bot's change they were shown. */
  const replace = async (asked: Problem) => {
    const buffer = buffers.buffer(asked.path);
    if (!buffer || asked.over === undefined) return;
    settle(asked.path, await buffer.replace(asked.over));
  };

  const notice: StatusNotice | undefined = problem
    ? {
        text: problem.message,
        action:
          problem.over === undefined
            ? { label: "Try again", run: () => void save(problem.path) }
            : {
                label: problem.gone ? "Save it again" : "Replace",
                run: () => void replace(problem),
              },
      }
    : snapshot?.dirty && focused !== undefined
      ? { text: "Unsaved changes", action: { label: "Save", run: () => void save(focused) } }
      : undefined;

  /** Tabs whose files have unsaved edits: Don't save drops the edits and closes them. */
  const confirmClose = (refs: readonly TabRef[]) => {
    const first = refs[0];
    if (!first) return;
    setConfirming({
      title: `Save changes to ${fileName(first.path)}?`,
      body: "Your changes are lost if you don't save them.",
      confirm: "Don't save",
      run: () => {
        void Promise.all(refs.map((ref) => buffers.buffer(ref.path)?.discard())).then(() =>
          change(discardTabs(current(), refs)),
        );
      },
    });
  };

  const renderEditor = (editor: BufferEditorProps) => (
    <BufferEditor {...editor} look={look} readOnly={!props.writable} />
  );
  const tabMenuItems = (path: string) => (
    <MenuItem onClick={() => props.onDownload(path)}>Download</MenuItem>
  );
  const renderViewer = (viewer: EditorViewerProps) => (
    <SpadeViewer bot={props.bot.id} {...viewer} onDownload={props.onDownload} />
  );

  return (
    <div
      className="flex h-full min-h-0 min-w-0 flex-1 flex-col"
      onKeyDownCapture={(event) => {
        const mod = event.metaKey || event.ctrlKey;
        if (!mod || event.shiftKey || event.altKey || event.key.toLowerCase() !== "s") return;
        event.preventDefault();
        event.stopPropagation();
        void save(focusedGroup(current()).active);
      }}
    >
      <Editor
        layout={layout}
        onLayoutChange={change}
        newGroupId={groupIds(layout)}
        buffers={buffers}
        paneCap={paneCap}
        statusNotice={notice}
        explorerToggle={props.explorerToggle}
        onConfirmClose={confirmClose}
        renderEditor={renderEditor}
        renderViewer={renderViewer}
        tabMenuItems={tabMenuItems}
      />
      <ConfirmDialog confirming={confirming} onDone={() => setConfirming(undefined)} />
    </div>
  );
}

/** A file the editor doesn't take as text: a picture or player drawn, else Download. */
function SpadeViewer(props: EditorViewerProps & { bot: string; onDownload(path: string): void }) {
  const notShown = (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
      <p className="text-ui text-muted-foreground">
        {props.reason === "large" ? "Too large to show here." : "This file can't be shown here."}
      </p>
      <Button size="sm" variant="secondary" onClick={() => props.onDownload(props.path)}>
        Download
      </Button>
    </div>
  );
  const mode = mediaModeOf(props.path, 0);
  if (!mode) return notShown;
  return (
    <FileMediaView
      bot={props.bot}
      path={props.path}
      mode={mode}
      revision={undefined}
      fallback={notShown}
    />
  );
}
