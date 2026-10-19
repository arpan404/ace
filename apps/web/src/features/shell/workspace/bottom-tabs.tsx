import { XIcon } from "@phosphor-icons/react";
import { useLayoutEffect, useRef, type KeyboardEvent } from "react";
import { Icon } from "@/components/icon.tsx";
import { Tip } from "@/components/ui/tooltip.tsx";
import { cn } from "@/lib/cn.ts";
import {
  shownTab,
  type ScopeWorkspace,
  type WorkspaceActions,
  type WorkspaceDefinition,
} from "@/lib/workspace/index.ts";
import { tabDomId } from "./tab-content.tsx";

/**
 * The bottom panel's tabs (its terminals): one tab stop, arrows move between tabs and show
 * them, Home/End jump, Delete closes, middle-click closes. Each tab has its close, kept in
 * place so titles never shift. No pinning or full view: the panel only holds terminals.
 */
export function BottomTabs(props: {
  label: string;
  group: ScopeWorkspace;
  definition: WorkspaceDefinition;
  actions: WorkspaceActions;
}) {
  const { group, definition, actions } = props;
  const shown = shownTab(group)?.key;
  const strip = useRef<HTMLDivElement>(null);
  /** After a keyboard move or close, the tab focus should land on once the strip re-renders. */
  const focusNext = useRef<string>(undefined);
  useLayoutEffect(() => {
    const key = focusNext.current;
    if (!key) return;
    focusNext.current = undefined;
    strip.current?.ownerDocument.getElementById(tabDomId(key, "tab"))?.focus();
  });
  const onKeyDown = (index: number) => (event: KeyboardEvent<HTMLButtonElement>) => {
    const tab = group.tabs[index];
    if (!tab) return;
    const last = group.tabs.length - 1;
    const goTo = (at: number) => {
      const target = group.tabs[at];
      if (!target) return;
      actions.activate(target.key);
      focusNext.current = target.key;
    };
    if (event.key === "ArrowRight") goTo(index === last ? 0 : index + 1);
    else if (event.key === "ArrowLeft") goTo(index === 0 ? last : index - 1);
    else if (event.key === "Home") goTo(0);
    else if (event.key === "End") goTo(last);
    else if (event.key === "Delete" || event.key === "Backspace") {
      const next = group.tabs[index + 1] ?? group.tabs[index - 1];
      // A shell that asks first keeps focus until the answer is yes.
      void actions.close(tab.key).then((closed) => {
        if (closed && next) focusNext.current = next.key;
      });
    } else return;
    event.preventDefault();
  };
  return (
    <div
      ref={strip}
      role="tablist"
      aria-label={props.label}
      className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto py-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
    >
      {group.tabs.map((tab, index) => {
        const kind = definition.kind(tab.kind);
        const title = definition.title(tab);
        const active = tab.key === shown;
        return (
          <div
            key={tab.key}
            className="group/tab relative flex h-7 max-w-[200px] min-w-0 shrink-0 items-center"
          >
            <button
              type="button"
              role="tab"
              id={tabDomId(tab.key, "tab")}
              aria-controls={tabDomId(tab.key, "panel")}
              aria-selected={active}
              tabIndex={active ? 0 : -1}
              onClick={() => actions.activate(tab.key)}
              onAuxClick={(event) => {
                if (event.button === 1) void actions.close(tab.key);
              }}
              onKeyDown={onKeyDown(index)}
              className={cn(
                "focus-ring flex h-7 w-full min-w-0 items-center gap-1.5 rounded-sm pr-7 pl-2 text-sm font-medium whitespace-nowrap text-muted-foreground",
                "transition-[color,background-color] duration-(--motion-fast)",
                "hover:text-foreground hover:not-aria-selected:bg-foreground/5",
                "aria-selected:bg-foreground/8 aria-selected:text-foreground",
              )}
            >
              <Icon
                icon={kind?.icon ?? XIcon}
                size={14}
                active={active}
                className="shrink-0 text-current opacity-80"
              />
              <span className="min-w-0 truncate">{title}</span>
            </button>
            <Tip label={kind?.closeLabel ?? `Close ${title}`}>
              <button
                type="button"
                tabIndex={-1}
                aria-label={`${kind?.closeLabel ?? "Close"} ${title}`}
                onClick={() => void actions.close(tab.key)}
                className={cn(
                  "absolute top-1/2 right-1 grid size-5 -translate-y-1/2 place-items-center rounded-xs text-subtle-foreground outline-none focus-ring",
                  "opacity-0 transition-[opacity,background-color,color] duration-(--motion-fast) group-focus-within/tab:opacity-100 group-hover/tab:opacity-100 pointer-coarse:opacity-100 hover:bg-accent hover:text-foreground",
                  active && "opacity-100",
                )}
              >
                <XIcon aria-hidden size={12} weight="bold" />
              </button>
            </Tip>
          </div>
        );
      })}
    </div>
  );
}
