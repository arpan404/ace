import { useEffect, useState } from "react";
import { desktopDaemon } from "@/boot/desktop.ts";

/**
 * A daemon the desktop started in safe mode runs without what kept it from starting (ADR 0175).
 * Says so in the desktop's own sentence; nothing for a healthy daemon or outside the desktop.
 */
export function SafeModeNotice(props: { scope?: object }) {
  const [sentence, setSentence] = useState<string>();
  useEffect(() => {
    const daemon = desktopDaemon(props.scope);
    if (!daemon) return;
    let current = true;
    const show = (status: { state: string; message?: string | undefined } | undefined) => {
      if (current) setSentence(status?.state === "running" ? status.message : undefined);
    };
    void daemon.status().then(show, () => {});
    const stop = daemon.onStatus(show);
    return () => {
      current = false;
      stop();
    };
  }, [props.scope]);
  if (!sentence) return null;
  return (
    <div role="status" className="flex min-h-9 items-center border-b px-4 text-ui">
      <span className="min-w-0 flex-1 text-sm text-muted-foreground">{sentence}</span>
    </div>
  );
}
