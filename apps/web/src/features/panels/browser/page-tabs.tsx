import { useAgent } from "@ace/client-react";
import { addressHost, agentName } from "@ace/ui-core";
import {
  CaretDownIcon,
  CheckIcon,
  CursorIcon,
  EyeSlashIcon,
  GlobeSimpleIcon,
  PlusIcon,
  XIcon,
} from "@phosphor-icons/react";
import { useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { Icon } from "@/components/icon.tsx";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "@/components/ui/menu.tsx";
import { Spinner } from "@/components/ui/spinner.tsx";
import { Tip } from "@/components/ui/tooltip.tsx";
import { cn } from "@/lib/cn.ts";
import type { BrowserTabView } from "../sources.ts";

/** A tab's name: the page's title, else its host, else what a new tab is called. */
export function tabTitle(tab: BrowserTabView): string {
  if (tab.title) return tab.title;
  if (!tab.url || tab.url === "about:blank") return "New tab";
  return addressHost(tab.url) ?? tab.url;
}

/** The agent working in a tab, by name when the thread knows it. */
function useWorker(threadId: string, tab: BrowserTabView): string | undefined {
  const agent = useAgent(threadId, tab.inUse?.agentId ?? "");
  if (!tab.inUse) return undefined;
  return agent ? agentName(agent) : "An agent";
}

/**
 * What leads a tab: the agent cursor while an agent works in it (the one colour, `working`),
 * a spinner while it loads, else its favicon or a globe.
 */
function TabMark(props: { tab: BrowserTabView; worker: string | undefined }) {
  const { tab } = props;
  if (props.worker)
    return (
      <span
        role="img"
        aria-label={`${props.worker} is using this tab`}
        className="grid size-4 shrink-0 place-items-center text-status-working"
      >
        <CursorIcon aria-hidden size={14} weight="fill" />
      </span>
    );
  if (tab.loading) return <Spinner className="size-3.5 shrink-0" />;
  if (tab.favicon)
    return (
      <img
        src={tab.favicon}
        alt=""
        aria-hidden
        draggable={false}
        className="size-4 shrink-0 rounded-xs"
      />
    );
  return <Icon icon={GlobeSimpleIcon} size={14} className="shrink-0 text-faint-foreground" />;
}

function PageTab(props: {
  threadId: string;
  tab: BrowserTabView;
  shown: boolean;
  onSelect(): void;
  onClose(): void;
  onKeyDown(event: KeyboardEvent<HTMLButtonElement>): void;
}) {
  const { tab } = props;
  const title = tabTitle(tab);
  const worker = useWorker(props.threadId, tab);
  const tip = worker
    ? `${title} · ${worker} is using this tab`
    : tab.private
      ? `${title} · Agents are kept out`
      : title;
  return (
    <div
      data-page-tab={tab.tabId}
      className="group/tab relative flex h-7 max-w-[200px] min-w-[88px] shrink"
    >
      <Tip label={tip}>
        <button
          type="button"
          role="tab"
          aria-selected={props.shown}
          tabIndex={props.shown ? 0 : -1}
          onClick={props.onSelect}
          // Middle-click closes, as in every browser; its press must not start autoscroll.
          onMouseDown={(event) => {
            if (event.button === 1) event.preventDefault();
          }}
          onAuxClick={(event) => {
            if (event.button === 1) props.onClose();
          }}
          onKeyDown={props.onKeyDown}
          className={cn(
            "focus-ring flex h-7 w-full min-w-0 items-center gap-1.5 rounded-sm pr-7 pl-2 text-ui whitespace-nowrap text-muted-foreground",
            "transition-[color,background-color,box-shadow] duration-(--motion-fast)",
            "hover:text-foreground hover:not-aria-selected:bg-foreground/5",
            "aria-selected:bg-foreground/8 aria-selected:text-foreground aria-selected:shadow-[var(--depth-highlight),var(--depth-raise)]",
          )}
        >
          <TabMark tab={tab} worker={worker} />
          <span className="min-w-0 truncate">{title}</span>
          {tab.private && (
            <EyeSlashIcon
              role="img"
              aria-label="Agents kept out"
              size={12}
              className="shrink-0 text-subtle-foreground"
            />
          )}
        </button>
      </Tip>
      <Tip label={`Close ${title}`}>
        <button
          type="button"
          tabIndex={-1}
          aria-label={`Close ${title}`}
          onClick={props.onClose}
          className={cn(
            "absolute top-1/2 right-1 grid size-5 -translate-y-1/2 place-items-center rounded-xs text-subtle-foreground outline-none",
            "opacity-0 transition-[opacity,background-color,color] duration-(--motion-fast) group-hover/tab:opacity-100 pointer-coarse:opacity-100 hover:bg-accent hover:text-foreground focus-visible:opacity-100",
            props.shown && "opacity-100",
          )}
        >
          <XIcon aria-hidden size={12} weight="bold" />
        </button>
      </Tip>
    </div>
  );
}

/**
 * The thread's browser tabs, as the daemon keeps them: the person's and every agent's, the
 * same on every device. Picking one shows it; ✕ or a middle-click closes it; + opens a new one.
 * A tab an agent works in leads with the agent cursor. Once the tabs no longer fit they
 * scroll, and a menu lists them all.
 */
export function PageTabs(props: {
  threadId: string;
  tabs: readonly BrowserTabView[];
  shownId: string | undefined;
  onSelect(tabId: string): void;
  onClose(tabId: string): void;
  onNew(): void;
}) {
  const { tabs } = props;
  const scroller = useRef<HTMLDivElement>(null);
  const focusNext = useRef<string>(undefined);
  const overflowing = useOverflow(scroller, tabs.length);
  // Keep the shown tab in view, as the strip scrolls.
  useLayoutEffect(() => {
    const element = scroller.current?.querySelector<HTMLElement>(
      `[data-page-tab="${CSS.escape(props.shownId ?? "")}"]`,
    );
    element?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
    const key = focusNext.current;
    if (!key) return;
    focusNext.current = undefined;
    scroller.current
      ?.querySelector<HTMLButtonElement>(`[data-page-tab="${CSS.escape(key)}"] [role="tab"]`)
      ?.focus();
  }, [props.shownId]);
  const onKeyDown = (index: number) => (event: KeyboardEvent<HTMLButtonElement>) => {
    const last = tabs.length - 1;
    const goTo = (at: number) => {
      const target = tabs[at];
      if (!target) return;
      focusNext.current = target.tabId;
      props.onSelect(target.tabId);
    };
    if (event.key === "ArrowRight") goTo(index === last ? 0 : index + 1);
    else if (event.key === "ArrowLeft") goTo(index === 0 ? last : index - 1);
    else if (event.key === "Home") goTo(0);
    else if (event.key === "End") goTo(last);
    else if (event.key === "Delete" || event.key === "Backspace") {
      const tab = tabs[index];
      if (tab) props.onClose(tab.tabId);
    } else return;
    event.preventDefault();
  };
  return (
    <div className="flex h-9 shrink-0 items-center gap-1 px-2">
      <div
        ref={scroller}
        role="tablist"
        aria-label="Browser tabs"
        className="flex min-w-0 items-center gap-0.5 overflow-x-auto py-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {tabs.map((tab, index) => (
          <PageTab
            key={tab.tabId}
            threadId={props.threadId}
            tab={tab}
            shown={tab.tabId === props.shownId}
            onSelect={() => props.onSelect(tab.tabId)}
            onClose={() => props.onClose(tab.tabId)}
            onKeyDown={onKeyDown(index)}
          />
        ))}
      </div>
      <IconButton
        icon={PlusIcon}
        label="New browser tab"
        tip="New tab"
        size="sm"
        className="size-7"
        onClick={props.onNew}
      />
      {overflowing && (
        <Menu>
          <MenuTrigger
            render={
              <IconButton
                icon={CaretDownIcon}
                label="All browser tabs"
                size="sm"
                className="size-7"
              />
            }
          />
          <MenuContent
            align="end"
            className="max-h-[min(420px,var(--available-height))] overflow-y-auto"
          >
            {tabs.map((tab) => (
              <MenuItem
                key={tab.tabId}
                icon={<ListMark threadId={props.threadId} tab={tab} />}
                onClick={() => props.onSelect(tab.tabId)}
              >
                <span className="flex min-w-0 items-center gap-2">
                  <span className="truncate">{tabTitle(tab)}</span>
                  {tab.tabId === props.shownId && (
                    <CheckIcon role="img" aria-label="Showing" size={12} />
                  )}
                </span>
              </MenuItem>
            ))}
          </MenuContent>
        </Menu>
      )}
    </div>
  );
}

function ListMark(props: { threadId: string; tab: BrowserTabView }) {
  return <TabMark tab={props.tab} worker={useWorker(props.threadId, props.tab)} />;
}

/** True once the tabs are wider than their strip, so the all-tabs menu appears. */
function useOverflow(scroller: React.RefObject<HTMLDivElement | null>, count: number) {
  const [overflowing, setOverflowing] = useState(false);
  useLayoutEffect(() => {
    const element = scroller.current;
    if (!element) return;
    const measure = () =>
      setOverflowing(count > 1 && element.scrollWidth > element.clientWidth + 1);
    measure();
    const observer =
      typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(measure);
    observer?.observe(element);
    return () => observer?.disconnect();
  }, [scroller, count]);
  return overflowing;
}
