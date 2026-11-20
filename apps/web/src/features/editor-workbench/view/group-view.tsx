import { useCallback, useState, type ReactNode } from "react";
import { cn } from "@/lib/cn.ts";
import { AgentNotice } from "./agent-notice.tsx";
import { Breadcrumbs } from "./breadcrumbs.tsx";
import { noticeClash, useSnapshot } from "./deck-buffers.ts";
import { DeckEditor } from "./deck-editor.tsx";
import type { EditorStatus, EditorStatusActions } from "@/features/editor";
import type { DeckEditorProps, DeckHost } from "./deck-host.ts";
import { carriesTab, copiesOnDrop, readTabDrag } from "./drag.ts";
import { FileProblem, LoadingLines, NoFileOpen } from "./editor-states.tsx";
import type { GroupActions } from "./group-actions.ts";
import { MarkdownChoice, MarkdownPreview, markdownShow } from "./markdown-view.tsx";
import { dropZone, type GroupNode, type Side } from "@ace/ui-core/editor-workbench";
import { TabStrip } from "./tab-strip.tsx";

/**
 * One group: its strip, breadcrumbs, the agent notice when the shown file's disk version moved
 * under unsaved edits, and the shown editor (only the active tab renders: spec 56). A tab dragged
 * over the editor washes the third it would take.
 */
export function GroupView(props: {
  group: GroupNode;
  /** 1-based, in reading order: what ⌘1–9 calls it. */
  number: number;
  focused: boolean;
  /** The only group: its emptiness is the Deck's empty state. */
  last: boolean;
  host: DeckHost;
  actions: GroupActions;
  stripLead?: ReactNode;
  groupMenu?: ReactNode;
}) {
  const { group, host, actions } = props;
  const path = group.active;
  const snapshot = useSnapshot(host.buffers, path);
  const buffer = path === undefined ? undefined : host.buffers.buffer(path);
  const load = snapshot?.status;
  const tab = group.tabs.find((each) => each.path === path);
  const markdown = markdownShow(tab);
  const [zone, setZone] = useState<Zone | undefined>(undefined);
  // Compare shows in place of the editor while the change it is about waits for an answer.
  const [comparing, setComparing] = useState<string | undefined>(undefined);
  const compare =
    path !== undefined &&
    comparing === path &&
    buffer !== undefined &&
    noticeClash(snapshot) !== undefined &&
    host.renderCompare
      ? host.renderCompare
      : undefined;
  const { reportStatus } = host;
  // Stable per group, so an editor can report from an effect without re-running it.
  const onStatus = useCallback(
    (status: EditorStatus | undefined, setters?: EditorStatusActions) =>
      reportStatus(group.id, status && { status, actions: setters ?? inertActions }),
    [reportStatus, group.id],
  );
  return (
    <section
      aria-label={`Group ${props.number}`}
      data-group-id={group.id}
      data-focused={props.focused ? "" : undefined}
      className="flex min-h-0 min-w-0 flex-1 flex-col bg-background"
      onFocusCapture={actions.focus}
      onPointerDownCapture={actions.focus}
    >
      <TabStrip
        group={group}
        focused={props.focused}
        buffers={host.buffers}
        actions={actions}
        lead={props.stripLead}
        groupMenu={props.groupMenu}
        tabMenuItems={host.tabMenuItems}
      />
      <Breadcrumbs
        path={path}
        end={
          path !== undefined &&
          markdown &&
          load?.kind === "ready" && (
            <MarkdownChoice
              value={markdown}
              onChange={(next) => actions.setView(path, { ...tab?.view, markdown: next })}
            />
          )
        }
      />
      {path !== undefined && (
        <AgentNotice
          snapshot={snapshot}
          buffers={host.buffers}
          comparing={compare !== undefined}
          onMerge={() => (host.onMerge ? host.onMerge(path) : void buffer?.merge())}
          onCompare={
            host.renderCompare &&
            (() => setComparing((was) => (was === path && compare ? undefined : path)))
          }
          onKeepMine={() => void buffer?.keepMine()}
          onTakeTheirs={() => void buffer?.takeTheirs()}
        />
      )}
      <div
        data-part="deck-editor"
        className="relative flex min-h-0 flex-1 flex-col"
        onDragOver={(event) => {
          if (!carriesTab(event.dataTransfer)) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = copiesOnDrop(event) ? "copy" : "move";
          const box = event.currentTarget.getBoundingClientRect();
          const next = dropZone({ x: event.clientX - box.left, y: event.clientY - box.top }, box);
          if (next !== zone) setZone(next);
        }}
        onDragLeave={(event) => {
          const into = event.relatedTarget;
          if (!(into instanceof Node && event.currentTarget.contains(into))) setZone(undefined);
        }}
        onDrop={(event) => {
          const drag = readTabDrag(event.dataTransfer);
          const at = zone ?? "center";
          setZone(undefined);
          if (!drag) return;
          event.preventDefault();
          actions.dropOnEditor(drag, at, copiesOnDrop(event));
        }}
      >
        {path === undefined ? (
          props.last ? (
            <NoFileOpen onQuickOpen={host.onQuickOpen} />
          ) : null
        ) : compare && buffer ? (
          compare({ path, buffer })
        ) : buffer && load?.kind === "ready" ? (
          markdown === "preview" ? (
            <MarkdownPreview buffer={buffer} />
          ) : (
            showEditor(host, { path, buffer, group: group.id, focused: props.focused, onStatus })
          )
        ) : load?.kind === "unreadable" && host.renderViewer ? (
          host.renderViewer({ path, group: group.id, reason: load.reason })
        ) : load &&
          (load.kind === "missing" || load.kind === "unreadable" || load.kind === "failed") ? (
          <FileProblem
            path={path}
            status={load}
            onClose={() => actions.close([path])}
            onRetry={() => void buffer?.reload()}
          />
        ) : (
          // Loading, or freed under the memory cap and reading again now it is shown.
          <LoadingLines />
        )}
        {zone && <DropWash zone={zone} />}
      </div>
    </section>
  );
}

type Zone = Side | "center";

/** The host's editor when it brings one (tests, the harness), else the Deck's own. */
function showEditor(host: DeckHost, editor: DeckEditorProps): ReactNode {
  if (host.renderEditor) return host.renderEditor(editor);
  // Keyed by path: a tab switch shows a fresh view on the other file's buffer.
  return <DeckEditor key={editor.path} {...editor} />;
}

/** For an editor that reported no setters: its status line's menus change nothing. */
const inertActions: EditorStatusActions = {
  setIndent: () => {},
  setLineEnding: () => {},
  setLanguage: () => {},
  setWhitespace: () => {},
};

/** The `--active` wash over the part of the group a drop would take (spec 16). */
function DropWash(props: { zone: Zone }) {
  return (
    <div
      aria-hidden
      data-drop-zone={props.zone}
      className={cn(
        "pointer-events-none absolute z-[2] rounded-sm bg-active/80 transition-[inset] duration-(--motion-fast)",
        props.zone === "center" && "inset-0",
        props.zone === "left" && "inset-y-0 right-1/2 left-0",
        props.zone === "right" && "inset-y-0 right-0 left-1/2",
        props.zone === "up" && "inset-x-0 top-0 bottom-1/2",
        props.zone === "down" && "inset-x-0 top-1/2 bottom-0",
      )}
    />
  );
}
