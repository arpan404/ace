import { useCallback, useMemo } from "react";
import { useDaemonConnection } from "@/boot/connection.tsx";
import { useSpace } from "./space-context.tsx";
import { orgOfHost, personalSpace } from "./spaces.ts";

/** The space a notice from this window's own machine belongs to (ADR 0206 §1.5). */
export interface NoticeSpace {
  /** The space's name for the notice, while the person has organizations to tell apart. */
  label: string | undefined;
  /** Switch the window to that space, before opening what the notice names. */
  enter(): void;
}

/**
 * Notices from every space arrive, labelled with their space, and opening one shows it in its
 * space: this machine's notices belong to the organization it hosts for, else to Personal.
 */
export function useOwnNoticeSpace(): NoticeSpace {
  const own = useDaemonConnection().account?.hostId;
  const { spaces, hostsOf, shown, choose } = useSpace();
  const org = orgOfHost(own, spaces ?? [], hostsOf);
  const id = org?.id ?? personalSpace;
  const enter = useCallback(() => {
    if (shown?.id !== id) choose(id);
  }, [shown, id, choose]);
  const label = spaces && spaces.length > 0 ? (org?.name ?? "Personal") : undefined;
  return useMemo(() => ({ label, enter }), [label, enter]);
}
