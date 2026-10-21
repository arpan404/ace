import { CaretDownIcon, CheckIcon, PlusIcon } from "@phosphor-icons/react";
import { useLayoutEffect, useRef, useState, type DragEvent, type KeyboardEvent } from "react";
import { Icon } from "@/components/icon.tsx";
import { IconButton } from "@/components/ui/icon-button.tsx";
import {
  Menu,
  MenuContent,
  MenuGroup,
  MenuItem,
  MenuLabel,
  MenuTrigger,
} from "@/components/ui/menu.tsx";
import type {
  ScopeWorkspace,
  WorkspaceActions,
  WorkspaceDefinition,
} from "@/lib/workspace/index.ts";
import { shownTab } from "@/lib/workspace/index.ts";
import { useReducedMotion } from "@/lib/motion.ts";
import { tabDragType, TabItem, type DropSide } from "./tab-item.tsx";
import { useRevealShown } from "./use-tab-layout.ts";

/**
 * The side panel's tabs: one tab stop (arrows move between tabs and show them, Home/End jump,
 * Delete closes, Alt+Shift+arrows reorder), drag to reorder, a + for a new tab and, once the
 * tabs no longer fit, a menu of all of them. Labels scroll at normal panel widths;
 * only a truly narrow strip folds the other tabs to icons. The strip
 * scroll, fading the edge it clips.
 */
export function TabStrip(props: {
  scope: string;
  label: string;
  state: ScopeWorkspace;
  definition: WorkspaceDefinition;
  actions: WorkspaceActions;
}) {
  const { state, actions, definition } = props;
  const shown = shownTab(state)?.key;
  const row = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  /** After a keyboard move or close, the tab focus should land on once the strip re-renders. */
  const focusNext = useRef<string>(undefined);
  const [drop, setDrop] = useState<{ key: string; side: DropSide }>();
  const [announcement, setAnnouncement] = useState("");
  const edges = useOverflow(scroller, state.tabs.length);
  useSidewaysWheel(scroller);
  const entering = useEntering(state.tabs.map((tab) => tab.key));
  useRevealShown(
    scroller,
    shown,
    state.tabs.findIndex((tab) => tab.key === shown),
  );
  useLayoutEffect(() => {
    const key = focusNext.current;
    if (!key) return;
    focusNext.current = undefined;
    tabButton(scroller.current, key)?.focus();
  });

  const titleOf = (key: string) => {
    const tab = state.tabs.find((each) => each.key === key);
    return tab ? definition.title(tab) : "";
  };

  const onKeyDown = (index: number) => (event: KeyboardEvent<HTMLButtonElement>) => {
    const tab = state.tabs[index];
    if (!tab) return;
    const last = state.tabs.length - 1;
    const goTo = (at: number) => {
      const target = state.tabs[at];
      if (!target) return;
      actions.activate(target.key);
      focusNext.current = target.key;
    };
    if (
      event.altKey &&
      event.shiftKey &&
      (event.key === "ArrowLeft" || event.key === "ArrowRight")
    ) {
      const to = index + (event.key === "ArrowLeft" ? -1 : 1);
      if (to < 0 || to > last) return;
      actions.move(tab.key, to);
      focusNext.current = tab.key;
      setAnnouncement(`${titleOf(tab.key)} moved to position ${to + 1} of ${last + 1}`);
    } else if (event.key === "ArrowRight") goTo(index === last ? 0 : index + 1);
    else if (event.key === "ArrowLeft") goTo(index === 0 ? last : index - 1);
    else if (event.key === "Home") goTo(0);
    else if (event.key === "End") goTo(last);
    else if (event.key === "Delete" || event.key === "Backspace") {
      const next = state.tabs[index + 1] ?? state.tabs[index - 1];
      const title = titleOf(tab.key);
      // A tab that asks first (a running shell) keeps focus until the answer is yes.
      void actions.close(tab.key).then((closed) => {
        if (!closed) return;
        if (next) tabButton(scroller.current, next.key)?.focus();
        setAnnouncement(`${title} closed`);
      });
    } else return;
    event.preventDefault();
  };

  const onDragOver = (event: DragEvent<HTMLElement>, key?: string, side: DropSide = "after") => {
    if (!event.dataTransfer.types.includes(tabDragType)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    // Between tabs or past either end, the slot nearest the pointer.
    const slot = key ? { key, side } : dropSlot(scroller.current, event.clientX);
    if (slot && (drop?.key !== slot.key || drop.side !== slot.side)) setDrop(slot);
  };
  const onDrop = (event: DragEvent<HTMLElement>) => {
    const key = event.dataTransfer.getData(tabDragType);
    const target = drop;
    setDrop(undefined);
    if (!key) return;
    event.preventDefault();
    const from = state.tabs.findIndex((tab) => tab.key === key);
    if (from === -1) return;
    const at = target ? state.tabs.findIndex((tab) => tab.key === target.key) : -1;
    if (at === -1) return actions.move(key, state.tabs.length - 1);
    let index = target?.side === "after" ? at + 1 : at;
    // The dragged tab leaves its old place first.
    if (from < index) index -= 1;
    actions.move(key, index);
  };

  const launcher = definition.kind(definition.launcher);
  return (
    <div ref={row} className="flex min-w-0 flex-1 items-center gap-1">
      <div
        ref={scroller}
        role="tablist"
        aria-label={props.label}
        style={{
          maskImage: `linear-gradient(to right, ${edges.left ? "transparent, black 24px" : "black, black 0px"}, ${edges.right ? "black calc(100% - 24px), transparent" : "black 100%, black"})`,
        }}
        onDragOverCapture={(event) => {
          // Held near either edge, the strip scrolls to the tabs beyond it.
          if (!event.dataTransfer.types.includes(tabDragType)) return;
          const box = event.currentTarget.getBoundingClientRect();
          const step = edgeScrollStep(event.clientX, box.left, box.right);
          if (step !== 0) event.currentTarget.scrollLeft += step;
        }}
        onDragOver={(event) => onDragOver(event)}
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDrop(undefined);
        }}
        onDrop={onDrop}
        className="relative flex min-w-0 items-center gap-0.5 overflow-x-auto px-0.5 py-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {state.tabs.map((tab, index) => (
          <TabItem
            key={tab.key}
            scope={props.scope}
            tab={tab}
            index={index}
            count={state.tabs.length}
            active={tab.key === shown}
            focusable={tab.key === shown}
            definition={definition}
            actions={actions}
            drop={drop?.key === tab.key ? drop.side : undefined}
            entering={entering.has(tab.key)}
            width={120}
            iconOnly={false}
            clipped={true}
            badgeDot={false}
            onKeyDown={onKeyDown(index)}
            onDragOver={(event, side) => {
              event.stopPropagation();
              onDragOver(event, tab.key, side);
            }}
          />
        ))}
      </div>
      {launcher && (
        <IconButton
          icon={PlusIcon}
          label="New tab"
          shortcut="newTab"
          size="sm"
          className="size-7 [-webkit-app-region:no-drag]"
          onPointerEnter={launcher.preload}
          onClick={() => actions.newTab()}
        />
      )}
      {edges.overflowing && (
        <Menu>
          <MenuTrigger
            render={
              <IconButton
                icon={CaretDownIcon}
                label="All tabs"
                size="sm"
                className="size-7 [-webkit-app-region:no-drag]"
              />
            }
          />
          <MenuContent
            align="end"
            className="max-h-[min(420px,var(--available-height))] overflow-y-auto"
          >
            <MenuGroup>
              <MenuLabel>Open tabs</MenuLabel>
              {state.tabs.map((tab) => (
                <MenuItem
                  key={tab.key}
                  icon={<Icon icon={definition.kind(tab.kind)?.icon ?? PlusIcon} />}
                  onClick={() => actions.activate(tab.key)}
                >
                  <span className="flex items-center gap-2">
                    <span className="truncate">{definition.title(tab)}</span>
                    {tab.key === shown && <CheckIcon role="img" aria-label="Showing" size={12} />}
                  </span>
                </MenuItem>
              ))}
            </MenuGroup>
          </MenuContent>
        </Menu>
      )}
      <span aria-live="polite" className="sr-only">
        {announcement}
      </span>
    </div>
  );
}

/** The tab button for `key` inside a strip. */
function tabButton(strip: HTMLElement | null, key: string): HTMLButtonElement | undefined {
  return [...(strip?.querySelectorAll<HTMLButtonElement>('[role="tab"]') ?? [])].find(
    (element) => element.closest("[data-tab-key]")?.getAttribute("data-tab-key") === key,
  );
}

/**
 * Where a tab dropped at `x` lands: before the first tab whose middle is past it, else after the
 * last. Covers the strip's padding and the gaps between tabs, so a drop at the far left goes
 * first rather than last.
 */
function dropSlot(
  strip: HTMLElement | null,
  x: number,
): { key: string; side: DropSide } | undefined {
  const boxes = [...(strip?.querySelectorAll<HTMLElement>(":scope > [data-tab-key]") ?? [])];
  for (const box of boxes) {
    const rect = box.getBoundingClientRect();
    const key = box.dataset.tabKey;
    if (key && x < rect.left + rect.width / 2) return { key, side: "before" };
  }
  const last = boxes.at(-1)?.dataset.tabKey;
  return last ? { key: last, side: "after" } : undefined;
}

/** How near an edge a held tab starts the strip scrolling, and its fastest step per dragover. */
const scrollEdge = 32;
const scrollStepMax = 14;

/**
 * How far one dragover scrolls the strip (pure): nothing in the middle, more the nearer the
 * pointer is to an edge, negative toward the left. Dragover repeats while the pointer is still,
 * so holding a tab at the edge keeps scrolling.
 */
function edgeScrollStep(x: number, left: number, right: number): number {
  const fromLeft = x - left;
  const fromRight = right - x;
  if (fromLeft < scrollEdge)
    return -Math.ceil(((scrollEdge - Math.max(0, fromLeft)) / scrollEdge) * scrollStepMax);
  if (fromRight < scrollEdge)
    return Math.ceil(((scrollEdge - Math.max(0, fromRight)) / scrollEdge) * scrollStepMax);
  return 0;
}

/** True once the tabs are wider than their strip, so the All tabs menu appears. */
function useOverflow(scroller: React.RefObject<HTMLDivElement | null>, count: number) {
  const [edges, setEdges] = useState({ overflowing: false, left: false, right: false });
  useLayoutEffect(() => {
    const element = scroller.current;
    if (!element) return;
    const measure = () => {
      const overflowing = count > 1 && element.scrollWidth > element.clientWidth + 1;
      const next = {
        overflowing,
        left: overflowing && element.scrollLeft > 1,
        right: overflowing && element.scrollLeft + element.clientWidth < element.scrollWidth - 1,
      };
      setEdges((before) =>
        before.overflowing === next.overflowing &&
        before.left === next.left &&
        before.right === next.right
          ? before
          : next,
      );
    };
    measure();
    element.addEventListener("scroll", measure, { passive: true });
    const observer =
      typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(measure);
    observer?.observe(element);
    return () => {
      observer?.disconnect();
      element.removeEventListener("scroll", measure);
    };
  }, [scroller, count]);
  return edges;
}

/** A wheel's lines, in pixels. */
const wheelLine = 16;
/** Wheel events closer together than this belong to one trackpad gesture. */
const swipeGapMs = 300;

/**
 * A vertical wheel over an overflowing strip scrolls it sideways: a mouse has no other way to
 * reach the tabs past its edge. At either end, and on a strip that fits, the wheel goes on to
 * the page. A trackpad's sideways swipe is left alone, vertical drift included. Not passive, so
 * a wheel it uses doesn't also scroll the panel.
 */
function useSidewaysWheel(scroller: React.RefObject<HTMLDivElement | null>) {
  useLayoutEffect(() => {
    const element = scroller.current;
    if (!element) return;
    /** When the last wheel event with sideways movement arrived (event time). */
    let sidewaysAt = Number.NEGATIVE_INFINITY;
    const onWheel = (event: WheelEvent) => {
      if (event.deltaX !== 0) sidewaysAt = event.timeStamp;
      // A trackpad swipe drifts up and down as it goes sideways; the rest of that gesture
      // stays the browser's own scroll, or the drift would push the strip back and forth.
      if (event.timeStamp - sidewaysAt < swipeGapMs) return;
      if (event.ctrlKey || Math.abs(event.deltaX) >= Math.abs(event.deltaY)) return;
      const room = element.scrollWidth - element.clientWidth;
      if (room <= 1) return;
      const unit =
        event.deltaMode === WheelEvent.DOM_DELTA_PAGE
          ? element.clientWidth
          : event.deltaMode === WheelEvent.DOM_DELTA_LINE
            ? wheelLine
            : 1;
      const next = Math.min(room, Math.max(0, element.scrollLeft + event.deltaY * unit));
      if (next === element.scrollLeft) return;
      event.preventDefault();
      element.scrollLeft = next;
    };
    element.addEventListener("wheel", onWheel, { passive: false });
    return () => element.removeEventListener("wheel", onWheel);
  }, [scroller]);
}

/** Keys that arrived since the last render, so a new tab pops in once (not on first paint). */
function useEntering(keys: readonly string[]): ReadonlySet<string> {
  const reduced = useReducedMotion();
  const [state, setState] = useState(() => ({ keys, entering: new Set<string>() }));
  const joined = keys.join("\n");
  if (state.keys.join("\n") !== joined) {
    const before = new Set(state.keys);
    setState({
      keys,
      entering: reduced ? new Set() : new Set(keys.filter((key) => !before.has(key))),
    });
  }
  return state.entering;
}
