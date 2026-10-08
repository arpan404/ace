import { useEffect, useState } from "react";
import { desktopDaemon, type DesktopDaemonStatus } from "@/boot/desktop.ts";
import { StatusLabel } from "./status-label.tsx";
import { Button } from "./ui/button.tsx";
import { useToast } from "./ui/toast.tsx";

/** Tray pause closes admission; ongoing work keeps its own status. */
export function PausedNotice() {
  const [desktop] = useState(() => desktopDaemon());
  const [status, setStatus] = useState<DesktopDaemonStatus>();
  const [pending, setPending] = useState(false);
  const toast = useToast();
  useEffect(() => {
    if (!desktop) return;
    let current = true;
    let announced = false;
    const stop = desktop.onStatus((next) => {
      announced = true;
      setStatus(next);
    });
    void desktop
      .status()
      .then((next) => {
        if (current && !announced) setStatus(next);
      })
      .catch(() => {});
    return () => {
      current = false;
      stop();
    };
  }, [desktop]);
  if (!status?.paused || !desktop?.pause) return null;
  return (
    <div role="status" className="flex min-h-9 items-center gap-2 border-b px-4 text-ui">
      <StatusLabel tone="needs-you" label="Paused" />
      <span className="min-w-0 flex-1 text-sm text-muted-foreground">New work is on hold.</span>
      <Button
        size="sm"
        variant="ghost"
        disabled={pending}
        onClick={() => {
          setPending(true);
          void desktop
            .pause?.(false)
            .then((next) => {
              if (next) setStatus(next);
            })
            .catch(() =>
              toast.error({
                title: "Couldn't resume new work",
                description: "Check the connection and try again.",
              }),
            )
            .finally(() => setPending(false));
        }}
      >
        Resume
      </Button>
    </div>
  );
}
