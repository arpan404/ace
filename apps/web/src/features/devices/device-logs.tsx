import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button.tsx";
import { cn } from "@/lib/cn.ts";
import { filterLines, logLevel } from "./device-log-lines.ts";
import type { DeviceSession } from "./device-session.ts";

const keep = 500;

export interface DeviceLogState {
  lines: readonly string[];
  dropped: number;
  error: boolean;
  paused: boolean;
  setPaused(paused: boolean): void;
  clear(): void;
  retry(): void;
}

/**
 * The device's log tail while `active` (the drawer shows Logs): logs start then and stop when it
 * closes or the tab goes. Paused, the shown lines hold still while new ones wait; Clear empties
 * the tail here only.
 */
export function useDeviceLogs(
  session: DeviceSession,
  deviceId: string,
  active: boolean,
): DeviceLogState {
  const [error, setError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [lines, setLines] = useState<readonly string[]>([]);
  const [held, setHeld] = useState<readonly string[] | undefined>();
  const [dropped, setDropped] = useState(0);
  useEffect(() => {
    // `attempt` is here so Retry starts the logs again; whoever shows them calls `clear` first.
    if (!active || attempt < 0) return;
    const release = session.client.watchLogs(deviceId, (batch) => {
      setLines((previous) => [...previous, ...batch.lines].slice(-keep));
      if (batch.dropped) setDropped((count) => count + batch.dropped);
    });
    let alive = true;
    void session.client.request({ op: "logs.start", deviceId }).catch(() => {
      if (alive) setError(true);
    });
    return () => {
      alive = false;
      release();
      void session.client.request({ op: "logs.stop", deviceId }).catch(() => {});
    };
  }, [active, session, deviceId, attempt]);
  return {
    lines: held ?? lines,
    dropped,
    error,
    paused: held !== undefined,
    setPaused: (paused) => setHeld(paused ? lines : undefined),
    clear: () => {
      setLines([]);
      setHeld((current) => (current ? [] : undefined));
      setDropped(0);
      setError(false);
    },
    retry: () => {
      setError(false);
      setAttempt((value) => value + 1);
    },
  };
}

/** The log lines, monospace, warnings and errors in their status colours, newest at the end. */
export function DeviceLogLines(props: { logs: DeviceLogState; filter: string }) {
  const { logs } = props;
  const shown = filterLines(logs.lines, props.filter);
  const scroller = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const count = shown.length;
  useLayoutEffect(() => {
    const element = scroller.current;
    if (element && pinned.current && count > 0) element.scrollTop = element.scrollHeight;
  }, [count]);
  return (
    <div
      ref={scroller}
      role="log"
      aria-label="Device logs"
      onScroll={(event) => {
        const element = event.currentTarget;
        pinned.current = element.scrollHeight - element.scrollTop - element.clientHeight < 24;
      }}
      className="h-full overflow-auto px-3 py-2 font-mono text-xs leading-relaxed text-muted-foreground"
    >
      {logs.error ? (
        <div role="alert" className="flex items-center gap-2 font-sans text-ui">
          <span>Couldn't start device logs. Check that the device is running, then retry.</span>
          <Button size="sm" variant="ghost" onClick={logs.retry}>
            Retry
          </Button>
        </div>
      ) : (
        <>
          {logs.dropped > 0 && (
            <p className="text-subtle-foreground">{logs.dropped} lines skipped</p>
          )}
          {shown.length === 0 ? (
            <p className="font-sans text-ui text-subtle-foreground">
              {logs.lines.length === 0 ? "No log lines yet" : "No lines match"}
            </p>
          ) : (
            shown.map((line, index) => {
              const level = logLevel(line);
              return (
                <p
                  // Lines repeat; their position in the tail is their identity.
                  // oxlint-disable-next-line react/no-array-index-key
                  key={index}
                  data-level={level}
                  {...(level === "info"
                    ? {}
                    : { "data-tone": level === "error" ? "failed" : "needs-you" })}
                  className={cn(
                    "break-all whitespace-pre-wrap",
                    level !== "info" && "text-(--tone-text)",
                  )}
                >
                  {line}
                </p>
              );
            })
          )}
        </>
      )}
    </div>
  );
}
