import { useOptionalClient } from "@ace/client-react";
import { startupWords } from "@ace/ui-core/host-care";
import { useEffect, useState } from "react";
import { desktopDaemon } from "@/boot/desktop.ts";
import { useAdmission } from "@/lib/admission.ts";

/** The desktop's own sentence for a daemon it started in safe mode, while the daemon is away. */
function useDesktopSentence(scope: object | undefined): string | undefined {
  const [sentence, setSentence] = useState<string>();
  useEffect(() => {
    const daemon = desktopDaemon(scope);
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
  }, [scope]);
  return sentence;
}

/**
 * A daemon that runs without something (ADR 0175): safe mode left a service off, or one is
 * failing and being retried. The daemon names it to every client; the desktop app's own sentence
 * stands in only while the daemon has not answered. Nothing for a healthy daemon.
 */
export function SafeModeNotice(props: { scope?: object }) {
  const admission = useAdmission(useOptionalClient());
  const fallback = useDesktopSentence(props.scope);
  const sentence = admission ? startupWords(admission.startup) : fallback;
  if (!sentence) return null;
  return (
    <div role="status" className="flex min-h-9 items-center border-b px-4 text-ui">
      <span className="min-w-0 flex-1 text-sm text-muted-foreground">{sentence}</span>
    </div>
  );
}
