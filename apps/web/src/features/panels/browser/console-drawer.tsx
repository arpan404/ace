import { ProhibitIcon, WarningIcon, XCircleIcon, XIcon } from "@phosphor-icons/react";
import { useCallback, useEffect, useState } from "react";
import { FilterMenu } from "@/components/ui/filter-menu.tsx";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { ResizeHandle } from "@/components/ui/resize-handle.tsx";
import { SegmentedControl } from "@/components/ui/segmented-control.tsx";
import { toolbarEdge } from "@/components/ui/rules.ts";
import { cn } from "@/lib/cn.ts";
import { LocalStore, useLocal } from "../store.ts";
import type { BrowserLogEntry, PreviewSource } from "../sources.ts";
import {
  consoleLevel,
  entryKeys,
  formatBytes,
  formatDuration,
  requestFailed,
  visibleEntries,
  type ConsoleLevel,
  type NetworkFilter,
} from "./console-filter.ts";

export type DrawerSection = "console" | "network";

/** How often an open drawer reads the tab's log again. */
const pollMs = 1000;
export const drawerHeights = { initial: 220, min: 120, max: 640 } as const;

/** Where the person last pressed Clear, per tab and section: entries up to it stay hidden. */
const cleared = new LocalStore<ReadonlyMap<string, number>>(new Map());
const clearKey = (threadId: string, tabId: string, section: DrawerSection) =>
  `${threadId}\u0000${tabId}\u0000${section}`;

const levels: readonly { value: ConsoleLevel; label: string }[] = [
  { value: "all", label: "All levels" },
  { value: "error", label: "Errors" },
  { value: "warning", label: "Warnings" },
  { value: "info", label: "Info" },
];
const requests: readonly { value: NetworkFilter; label: string }[] = [
  { value: "all", label: "All requests" },
  { value: "failed", label: "Failed" },
];

/** The tab's log, read again every second while the drawer shows and the window is visible. */
function useTabLog(source: PreviewSource, threadId: string, tabId: string) {
  const [entries, setEntries] = useState<readonly BrowserLogEntry[]>([]);
  useEffect(() => {
    const read = source.logs;
    if (!read) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = () => {
      if (!alive) return;
      if (document.visibilityState === "hidden") {
        timer = setTimeout(tick, pollMs);
        return;
      }
      void read(threadId, tabId)
        .then((next) => {
          if (alive) setEntries(next);
        })
        .catch(() => {})
        .finally(() => {
          if (alive) timer = setTimeout(tick, pollMs);
        });
    };
    tick();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [source, threadId, tabId]);
  return entries;
}

/**
 * A light drawer under the page with the tab's console messages and network requests: the same
 * log agents read (`browser_logs`). Console filters by level; network lists status, method,
 * address, size and time, and can show only failures. Clear hides what is listed now (agents
 * keep their log). Not DevTools: nothing to inspect or edit.
 */
export function ConsoleDrawer(props: {
  source: PreviewSource;
  threadId: string;
  tabId: string;
  section: DrawerSection;
  onSection(section: DrawerSection): void;
  height: number;
  onHeight(height: number, persist: boolean): void;
  onClose(): void;
}) {
  const { threadId, tabId, section } = props;
  const entries = useTabLog(props.source, threadId, tabId);
  const [level, setLevel] = useState<ConsoleLevel>("all");
  const [filter, setFilter] = useState<NetworkFilter>("all");
  const key = clearKey(threadId, tabId, section);
  const clearedAt = useLocal(
    cleared,
    useCallback((all: ReadonlyMap<string, number>) => all.get(key), [key]),
  );
  const shown =
    section === "console"
      ? visibleEntries(entries, { kind: "console", level, clearedAt })
      : visibleEntries(entries, { kind: "network", filter, clearedAt });
  const clear = () => {
    const newest = entries.findLast((entry) => entry.kind === section)?.at;
    if (newest === undefined) return;
    cleared.set((all) => new Map(all).set(key, newest));
  };
  return (
    <section
      aria-label="Console and network"
      style={{ height: props.height }}
      className="relative flex shrink-0 flex-col border-t border-border bg-panel"
    >
      <ResizeHandle
        label="Resize the console"
        edge="top"
        size={props.height}
        min={drawerHeights.min}
        max={drawerHeights.max}
        onResize={(height) => props.onHeight(height, false)}
        onResizeEnd={(height) => props.onHeight(height, true)}
      />
      <div className={cn("flex h-9 shrink-0 items-center gap-1 px-2", toolbarEdge)}>
        <SegmentedControl
          size="sm"
          label="Log"
          value={section}
          options={[
            { value: "console", label: "Console" },
            { value: "network", label: "Network" },
          ]}
          onValueChange={props.onSection}
        />
        {section === "console" ? (
          <FilterMenu<ConsoleLevel>
            label="Level"
            value={level}
            options={levels}
            onValueChange={setLevel}
          />
        ) : (
          <FilterMenu<NetworkFilter>
            label="Requests"
            value={filter}
            options={requests}
            onValueChange={setFilter}
          />
        )}
        <span className="flex-1" />
        <IconButton
          size="sm"
          icon={ProhibitIcon}
          label={section === "console" ? "Clear the console" : "Clear the requests"}
          tip="Clear"
          onClick={clear}
        />
        <IconButton size="sm" icon={XIcon} label="Close the console" onClick={props.onClose} />
      </div>
      <div className="min-h-0 flex-1 overflow-auto font-mono text-xs">
        {shown.length === 0 ? (
          <p className="px-3 pt-2 font-sans text-ui text-muted-foreground">
            {section === "console" ? "No messages" : "No requests"}
          </p>
        ) : section === "console" ? (
          <ConsoleList entries={shown} />
        ) : (
          <NetworkTable entries={shown} />
        )}
      </div>
    </section>
  );
}

function ConsoleList(props: { entries: readonly BrowserLogEntry[] }) {
  const keys = entryKeys(props.entries);
  return (
    <ul aria-label="Console messages" className="divide-y divide-border-soft">
      {props.entries.map((entry, index) => {
        const bucket = consoleLevel(entry.type);
        return (
          <li
            key={keys[index]}
            data-level={bucket}
            className={cn(
              "flex items-start gap-1.5 px-3 py-1 break-all whitespace-pre-wrap",
              bucket === "error" ? "text-destructive" : "text-foreground",
            )}
          >
            {bucket === "error" ? (
              <XCircleIcon aria-label="Error" size={12} className="mt-0.5 shrink-0" />
            ) : bucket === "warning" ? (
              <WarningIcon
                aria-label="Warning"
                size={12}
                className="mt-0.5 shrink-0 text-muted-foreground"
              />
            ) : (
              <span aria-hidden className="w-3 shrink-0" />
            )}
            <span className="min-w-0">{entry.text}</span>
          </li>
        );
      })}
    </ul>
  );
}

function NetworkTable(props: { entries: readonly BrowserLogEntry[] }) {
  const keys = entryKeys(props.entries);
  return (
    <table aria-label="Network requests" className="w-full table-fixed border-collapse">
      <thead className="sticky top-0 bg-panel text-left font-sans text-subtle-foreground">
        <tr>
          <th className="w-14 px-3 py-1 font-normal">Status</th>
          <th className="w-14 py-1 font-normal">Method</th>
          <th className="py-1 font-normal">Address</th>
          <th className="w-16 py-1 text-right font-normal">Size</th>
          <th className="w-16 py-1 pr-3 text-right font-normal">Time</th>
        </tr>
      </thead>
      <tbody>
        {props.entries.map((entry, index) => {
          const failed = requestFailed(entry);
          return (
            <tr
              key={keys[index]}
              data-failed={failed ? "" : undefined}
              className={cn("border-t border-border-soft", failed && "text-destructive")}
            >
              <td className="px-3 py-1 tabular-nums">
                {entry.type === "failed" ? "Failed" : (entry.status ?? "")}
              </td>
              <td className="py-1">{entry.method ?? ""}</td>
              <td className="truncate py-1" title={entry.url ?? entry.text}>
                {entry.url ?? entry.text}
              </td>
              <td className="py-1 text-right tabular-nums">{formatBytes(entry.bytes)}</td>
              <td className="py-1 pr-3 text-right tabular-nums">
                {formatDuration(entry.durationMs)}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
