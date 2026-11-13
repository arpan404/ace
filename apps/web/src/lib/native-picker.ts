import { useEffect, useRef, useState } from "react";
import { useDaemonConnection } from "@/boot/connection.tsx";
import { desktopFolders } from "@/boot/desktop-folders.ts";

/**
 * The desktop app's folder picker, when the daemon runs on this computer and `primary` (the
 * machine chosen is this window's own). Undefined in a browser or for another machine.
 */
export function useNativePicker(primary: boolean) {
  const [picker] = useState(() => desktopFolders());
  const endpoint = useDaemonConnection().endpoint;
  const target = endpoint?.kind === "daemon" ? endpoint.target : undefined;
  const [confirmed, setConfirmed] = useState<typeof target>();
  const generation = useRef(0);
  useEffect(() => {
    const revision = ++generation.current;
    if (picker && primary && target)
      void picker.local(target).then((local) => {
        if (generation.current === revision) setConfirmed(local ? target : undefined);
      });
    return () => {
      generation.current = revision + 1;
    };
  }, [picker, primary, target]);
  if (!picker || !primary || !target || confirmed !== target) return undefined;
  return {
    /** The folder chosen, or null when cancelled or the daemon moved meanwhile. */
    async choose(): Promise<string | null> {
      const revision = generation.current;
      if (!(await picker.local(target))) return null;
      const chosen = await picker.choose();
      return generation.current === revision && (await picker.local(target)) ? chosen : null;
    },
  };
}
