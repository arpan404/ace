import { CaretDownIcon, CheckIcon, PlusIcon } from "@phosphor-icons/react";
import { useLayoutEffect, useRef, useState, type DragEvent, type KeyboardEvent } from "react";
import { Icon } from "@/components/icon.tsx";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { Menu, MenuContent, MenuItem, MenuLabel, MenuTrigger } from "@/components/ui/menu.tsx";
import type {
  ScopeWorkspace,
  WorkspaceActions,
  WorkspaceDefinition,
} from "@/lib/workspace/index.ts";
import { shownTab } from "@/lib/workspace/index.ts";
import { useReducedMotion } from "@/lib/motion.ts";
import { tabDragType, TabItem, type DropSide } from "./tab-item.tsx";
import { useEdgeFade } from "@/lib/edge-fade.ts";
import { useRevealShown, useTabFit } from "./use-tab-layout.ts";

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
  const overflowing = useOverflow(scroller, state.tabs.length);
  const entering = useEntering(state.tabs.map((tab) => tab.key));
  const fit = useTabFit(row, scroller, shown);
  const mask = useEdgeFade(scroller);
  useRevealShown(scroller, shown);
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
    else if ((event.key === "Delete" || event.key === "Backspace") && !tab.pinned) {
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
    const target = key ?? state.tabs.at(-1)?.key;
    if (target && (drop?.key !== target || drop.side !== side)) setDrop({ key: target, side });
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
        style={mask ? { maskImage: mask, WebkitMaskImage: mask } : undefined}
        role="tablist"
        aria-label={props.label}
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
            width={fit?.widths.get(tab.key)}
            iconOnly={fit?.icons.has(tab.key) ?? false}
            clipped={fit?.clipped.has(tab.key) ?? false}
            badgeDot={fit?.dots.has(tab.key) ?? false}
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
      {overflowing && (
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

/** True once the tabs are wider than their strip, so the All tabs menu appears. */
function useOverflow(scroller: React.RefObject<HTMLDivElement | null>, count: number): boolean {
  const [overflowing, setOverflowing] = useState(false);
  useLayoutEffect(() => {
    const element = scroller.current;
    if (!element) return;
    const measure = () =>
      setOverflowing(count > 1 && element.scrollWidth > element.clientWidth + 1);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [scroller, count]);
  return overflowing;
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
