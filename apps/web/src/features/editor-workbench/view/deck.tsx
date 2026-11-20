import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { MenuItem, MenuSeparator } from "@/components/ui/menu.tsx";
import type { DeckHost, StatusNotice } from "./deck-host.ts";
import {
  evenSplit,
  focusedGroup,
  focusGroup,
  groupsOf,
  resizeSplit,
  type GroupNode,
} from "@ace/ui-core/editor-workbench";
import { bindGroupActions, groupContext, type DeckLayoutProps } from "./group-actions.ts";
import { GroupView } from "./group-view.tsx";
import { fileName } from "./paths.ts";
import { SplitGrid } from "./split-grid.tsx";
import { StatusLine } from "./status-line.tsx";
import { createStatusStore, useStatusReport, type StatusStore } from "./status-store.ts";

/** Spec 5: under this width the Deck shows only the focused group. */
export const compactBelowPx = 760;

export interface DeckProps extends Omit<DeckHost, "reportStatus">, DeckLayoutProps {
  /**
   * The status line's left notice: what needs a look across open files ("Claude Code changed
   * 2 open files" with Next change, once change marks exist).
   */
  statusNotice?: StatusNotice | undefined;
  /** Compact layout's way to the explorer ("Show files"), at the strip's left. */
  explorerToggle?: ReactNode;
}

/**
 * The Deck: a thread's editor area. Groups in a split tree, each with its own strip; one status
 * line for the focused group; ⌘1–9 focus groups while focus is inside it (spec 27).
 */
export function Deck(props: DeckProps) {
  const { layout, onLayoutChange } = props;
  const root = useRef<HTMLDivElement>(null);
  const compact = useCompact(root);
  const groups = groupsOf(layout);
  const context = groupContext(props);
  const focused = focusedGroup(layout);
  // Status lives outside the Deck's state: a caret move redraws the status line alone.
  const [status] = useState(createStatusStore);
  const host: DeckHost = { ...props, reportStatus: status.report };
  const pendingFocus = useRef(false);

  useEffect(() => {
    if (!pendingFocus.current) return;
    pendingFocus.current = false;
    focusInside(
      root.current?.querySelector<HTMLElement>(`[data-group-id="${CSS.escape(focused.id)}"]`),
    );
  }, [focused.id]);

  const renderGroup = (group: GroupNode, others?: ReactNode) => {
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
        stripLead={compact && isFocused ? props.explorerToggle : undefined}
        groupMenu={others}
      />
    );
  };

  return (
    <div
      ref={root}
      role="group"
      aria-label="Deck"
      data-part="deck"
      data-compact={compact ? "" : undefined}
      className="flex h-full min-h-0 min-w-0 flex-col bg-background"
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
        {compact ? (
          renderGroup(
            focused,
            groups.length > 1 && (
              <>
                {groups.map((group, index) =>
                  group.id === focused.id ? null : (
                    <MenuItem
                      key={group.id}
                      onClick={() => onLayoutChange(focusGroup(layout, group.id))}
                    >
                      {`Group ${index + 1}: ${group.active ? fileName(group.active) : "empty"}`}
                    </MenuItem>
                  ),
                )}
                <MenuSeparator />
              </>
            ),
          )
        ) : (
          <SplitGrid
            node={layout.root}
            renderGroup={(group) => renderGroup(group)}
            onResize={(at, sizes) => onLayoutChange(resizeSplit(layout, at, sizes))}
            onEven={(at) => onLayoutChange(evenSplit(layout, at))}
          />
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
      '[data-part="deck-editor"] [tabindex]:not([tabindex="-1"])',
    ) ??
    group?.querySelector<HTMLElement>('[data-part="deck-editor"] textarea') ??
    group?.querySelector<HTMLElement>('[role="tab"][tabindex="0"]');
  target?.focus();
}

function useCompact(root: React.RefObject<HTMLDivElement | null>): boolean {
  const [compact, setCompact] = useState(false);
  useLayoutEffect(() => {
    const element = root.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const measure = () => {
      const width = element.getBoundingClientRect().width;
      setCompact(width > 0 && width < compactBelowPx);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [root]);
  return compact;
}
