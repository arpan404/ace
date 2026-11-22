import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { WordChoice } from "@/components/ui/word-choice.tsx";
import type { EditorHost, StatusNotice } from "./editor-host.ts";
import {
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
   * The groups don't fit side by side: the editor needs this much width to show them all. The
   * panel widens if it can; until then one group shows, the others a click away.
   */
  onNeedRoom?: ((width: number) => void) | undefined;
}

/**
 * The editor: a thread's editor area. Groups in a split tree, each with its own strip; one status
 * line for the focused group; ⌘1–9 focus groups while focus is inside it (spec 27).
 */
export function Editor(props: EditorProps) {
  const { layout, onLayoutChange } = props;
  const root = useRef<HTMLDivElement>(null);
  const box = useBox(root);
  const groups = groupsOf(layout);
  // A split the person asked for shows whenever each group gets its room (spec 5).
  const sideBySide = groupsFit(layout.root, box);
  const needed = sideBySide ? undefined : roomNeeded(layout.root).width;
  const { onNeedRoom } = props;
  useEffect(() => {
    if (needed !== undefined) onNeedRoom?.(needed);
  }, [needed, onNeedRoom]);
  const context = groupContext(props);
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

  const leadOf = (group: GroupNode) => {
    // The explorer's toggle sits at the left of the first strip on screen.
    const first = sideBySide ? groups[0]?.id === group.id : true;
    const toggle = first ? props.explorerToggle : undefined;
    const switcher = !sideBySide && groups.length > 1 && (
      <WordChoice
        label="Groups"
        value={focused.id}
        // Past two groups the words are their numbers, so the switcher fits a narrow strip.
        options={groups.map((each, index) => ({
          value: each.id,
          label: groups.length > 2 ? `${index + 1}` : `Group ${index + 1}`,
          name: `Group ${index + 1}`,
        }))}
        onValueChange={(id) => onLayoutChange(focusGroup(layout, id))}
        className="mr-1 shrink-0"
      />
    );
    return toggle || switcher ? (
      <>
        {toggle}
        {switcher}
      </>
    ) : undefined;
  };

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
      data-compact={sideBySide ? undefined : ""}
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
        {sideBySide ? (
          <SplitGrid
            node={layout.root}
            renderGroup={renderGroup}
            onResize={(at, sizes) => onLayoutChange(resizeSplit(layout, at, sizes))}
            onEven={(at) => onLayoutChange(evenSplit(layout, at))}
          />
        ) : (
          renderGroup(focused)
        )}
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
