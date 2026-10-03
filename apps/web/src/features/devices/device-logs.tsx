import { CaretRightIcon } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import { Icon } from "@/components/icon.tsx";
import { cn } from "@/lib/cn.ts";
import type { DeviceSession } from "./device-session.ts";

const keep = 200;

/**
 * The device's log tail, only while open: logs start on open and stop on close. Keyed by
 * device, so another device starts with an empty tail.
 */
export function DeviceLogs(props: { session: DeviceSession; deviceId: string }) {
  const [open, setOpen] = useState(false);
  const [lines, setLines] = useState<readonly string[]>([]);
  const [dropped, setDropped] = useState(0);
  const { session, deviceId } = props;

  useEffect(() => {
    if (!open) return;
    const release = session.client.watchLogs(deviceId, (batch) => {
      setLines((previous) => [...previous, ...batch.lines].slice(-keep));
      if (batch.dropped) setDropped((count) => count + batch.dropped);
    });
    void session.client.request({ op: "logs.start", deviceId }).catch(() => {});
    return () => {
      release();
      void session.client.request({ op: "logs.stop", deviceId }).catch(() => {});
    };
  }, [open, session, deviceId]);

  return (
    <section className="border-t">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => {
          if (!open) {
            setLines([]);
            setDropped(0);
          }
          setOpen(!open);
        }}
        className="flex w-full items-center gap-1.5 px-3 py-2 text-left text-sm font-medium text-muted-foreground hover:text-foreground"
      >
        <Icon
          icon={CaretRightIcon}
          size={12}
          className={cn("transition-transform duration-(--dur-1)", open && "rotate-90")}
        />
        Logs
      </button>
      {open && (
        <div
          role="log"
          aria-label="Device logs"
          className="max-h-56 overflow-auto px-3 pb-3 font-mono text-xs leading-relaxed text-muted-foreground"
        >
          {dropped > 0 && <p className="text-subtle-foreground">{dropped} lines skipped</p>}
          {lines.length === 0 ? (
            <p className="text-subtle-foreground">Waiting for the device to log something.</p>
          ) : (
            lines.map((line, index) => (
              // Lines repeat; their position in the tail is their identity.
              // oxlint-disable-next-line react/no-array-index-key
              <p key={index} className="break-all whitespace-pre-wrap">
                {line}
              </p>
            ))
          )}
        </div>
      )}
    </section>
  );
}
