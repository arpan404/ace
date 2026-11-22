import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { EditorHost, StatusNotice } from "./editor-host.ts";
import {
  displayPanes,
  evenSplit,
  focusedGroup,
  focusGroup,
  groupsFit,
  groupsOf,
  resizeSplit,
  roomNeeded,
  type GroupNode,
} from "@ace/ui-core/editor-workbench";
import { bindGroupActions, groupContext, type EditorLayoutProps } from "./group-actions.ts";
import { GroupView } from "./group-view.tsx";
import { SplitGrid } from "./split-grid.tsx";
import { StatusLine } from "./status-line.tsx";
import { createStatusStore, useStatusReport, type StatusStore } from "./status-store.ts";
import { sceneThrough } from "@/components/ui/rules.ts";

export interface EditorProps extends Omit<EditorHost, "reportStatus">, EditorLayoutProps {
  /**
   * The status line's left notice: what needs a look across open files ("Claude Code changed
   * 2 open files" with Next change, once change marks exist).
   */
  statusNotice?: StatusNotice | undefined;
  /**
   * The way to an explorer that stepped aside ("Show files"), at the first strip's left. The
   * panel passes it only while the explorer isn't docked beside the code.
   */
  explorerToggle?: ReactNode;
  /**
   * The panes don't fit side by side at their roomy width: the editor needs this much. The panel
   * widens if it can; meanwhile the panes sit narrower, or stacked, but always on screen.
   */
  onNeedRoom?: ((width: number) => void) | undefined;
}

/**
 * The editor: a thread's editor area. Panes in a split tree, each with its own strip; one status
 * line for the focused pane; ⌘1–9 focus panes while focus is inside it (spec 27).
 */
export function Editor(props: EditorProps) {
  const { layout, onLayoutChange } = props;
  const root = useRef<HTMLDivElement>(null);
  const box = useBox(root);
  const groups = groupsOf(layout);
  // Every pane the person made is on screen (spec 5): side by side as room allows, else stacked.
  const shown = displayPanes(layout.root, box);
  const needed = groupsFit(layout.root, box) ? undefined : roomNeeded(layout.root).width;
  const { onNeedRoom } = props;
  useEffect(() => {
    if (needed !== undefined) onNeedRoom?.(needed);
  }, [needed, onNeedRoom]);
  const context = groupContext(props, box);
  const focused = focusedGroup(layout);
  // Status lives outside the editor's state: a caret move redraws the status line alone.
  const [status] = useState(createStatusStore);
  const host: EditorHost = { ...props, reportStatus: status.report };
  const pendingFocus = useRef(false);

  // Groups on screen last time: a focused group that wasn't among them was just made (a split,
  // a drop on an edge), and the keyboard follows it there rather than staying in the old view.
  const known = useRef(new Set(groups.map((group) => group.id)));
  const ids = groups.map((group) => group.id).join(" ");
  useEffect(() => {
    const made = !known.current.has(focused.id);
    known.current = new Set(ids.split(" "));
    if (!pendingFocus.current && !made) return;
    pendingFocus.current = false;
    focusInside(
      root.current?.querySelector<HTMLElement>(`[data-group-id="${CSS.escape(focused.id)}"]`),
    );
  }, [focused.id, ids, known]);

  // The explorer's toggle sits at the left of the first pane's strip.
  const leadOf = (group: GroupNode) =>
    groups[0]?.id === group.id ? props.explorerToggle : undefined;

  const renderGroup = (group: GroupNode) => {
    const number = groups.indexOf(group) + 1;
    const isFocused = group.id === focused.id;
    return (
      <GroupView
        key={group.id}
        group={group}
        number={number}
        focused={isFocused}
        last={groups.length === 1}
        host={host}
        actions={bindGroupActions(group.id, context)}
        stripLead={leadOf(group)}
      />
    );
  };

  return (
    <div
      ref={root}
      role="group"
      aria-label="Editor"
      data-part="editor"
      data-stacked={shown.root === layout.root ? undefined : ""}
      className={`flex h-full min-h-0 min-w-0 flex-col bg-background ${sceneThrough}`}
      onKeyDown={(event) => {
        const number = groupKey(event);
        if (number === undefined) return;
        const target = groups[number - 1];
        // Unclaimed: a ⌘ digit with no such group falls through to the app (open thread n).
        if (!target) return;
        event.preventDefault();
        event.stopPropagation();
        if (target.id === focused.id) {
          focusInside(
            root.current?.querySelector<HTMLElement>(`[data-group-id="${CSS.escape(target.id)}"]`),
          );
          return;
        }
        pendingFocus.current = true;
        onLayoutChange(focusGroup(layout, target.id));
      }}
    >
      <div className="flex min-h-0 flex-1">
        <SplitGrid
          node={shown.root}
          pane={shown.pane}
          renderGroup={renderGroup}
          onResize={(at, sizes) => onLayoutChange(resizeSplit(layout, at, sizes))}
          onEven={(at) => onLayoutChange(evenSplit(layout, at))}
        />
      </div>
      <FocusedStatusLine store={status} group={focused.id} notice={props.statusNotice} />
    </div>
  );
}

/** The status line on the focused group's report: the one part a status change redraws. */
function FocusedStatusLine(props: {
  store: StatusStore;
  group: string;
  notice: StatusNotice | undefined;
}) {
  return <StatusLine report={useStatusReport(props.store, props.group)} notice={props.notice} />;
}

/** ⌘1–⌘9 on macOS, Ctrl+1–9 elsewhere; ⌥ is allowed too, for the web's ⌥⌘ variant. */
function groupKey(event: React.KeyboardEvent): number | undefined {
  if (!(event.metaKey || event.ctrlKey) || event.shiftKey) return undefined;
  const match = /^Digit([1-9])$/.exec(event.code);
  return match ? Number(match[1]) : undefined;
}

/** Put focus in a group: its editor when it has one, else its strip's tab stop. */
function focusInside(group: HTMLElement | null | undefined): void {
  const target =
    group?.querySelector<HTMLElement>(
      '[data-part="buffer-editor"] [tabindex]:not([tabindex="-1"])',
    ) ??
    group?.querySelector<HTMLElement>('[data-part="buffer-editor"] textarea') ??
    group?.querySelector<HTMLElement>('[role="tab"][tabindex="0"]');
  target?.focus();
}

/** The editor's measured size; zero until it has been laid out. */
function useBox(root: React.RefObject<HTMLDivElement | null>): { width: number; height: number } {
  const [box, setBox] = useState({ width: 0, height: 0 });
  useLayoutEffect(() => {
    const element = root.current;
    if (!element) return;
    const measure = () => {
      const { width, height } = element.getBoundingClientRect();
      setBox((was) => (was.width === width && was.height === height ? was : { width, height }));
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [root]);
  return box;
}
