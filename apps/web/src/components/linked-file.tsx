import { useClient } from "@ace/client-react";
import { ItemId, ThreadId } from "@ace/protocol";
import { createContext, useCallback, useState, type ReactNode } from "react";
import { DownloadError, saveDownload } from "@/lib/save-download.ts";
import { useToast } from "./ui/toast.tsx";

/** Which message links a file outside the checkout, and what the link says. */
export interface LinkedFileTarget {
  threadId: string;
  itemId: string;
  reference: string;
  name: string;
}

/**
 * Downloads a file a message links outside the thread's checkout. The daemon serves it only
 * because that message links it, so it works from any device that can read the thread. A file
 * the host can't serve says so in a toast.
 */
export function useLinkedFileDownload(): (target: LinkedFileTarget) => Promise<void> {
  const client = useClient();
  const toast = useToast();
  return useCallback(
    async (target: LinkedFileTarget) => {
      try {
        await saveDownload(
          target.name,
          client.downloadFile({
            threadId: ThreadId.parse(target.threadId),
            op: "link.download",
            itemId: ItemId.parse(target.itemId),
            reference: target.reference,
            offset: 0,
          }),
        );
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") return;
        toast.error({
          title: `Couldn't open ${target.name}`,
          description:
            error instanceof DownloadError
              ? error.message
              : "Check that the file is still there, then try again.",
        });
      }
    },
    [client, toast],
  );
}

/** Downloads a linked file for prose on a thread's screen; provided by `ThreadLinkedFiles`. */
export const LinkedFileOpener = createContext<((target: LinkedFileTarget) => void) | undefined>(
  undefined,
);

/** Lets the thread's answers download the files they link outside the checkout. */
export function ThreadLinkedFiles(props: { children: ReactNode }) {
  const download = useLinkedFileDownload();
  const open = useCallback((target: LinkedFileTarget) => void download(target), [download]);
  return <LinkedFileOpener value={open}>{props.children}</LinkedFileOpener>;
}

/** A message's link to a file outside the thread's checkout, as a button that downloads it. */
export function LinkedFile(props: LinkedFileTarget & { children: ReactNode }) {
  const download = useLinkedFileDownload();
  const [busy, setBusy] = useState(false);
  const { children, ...target } = props;
  return (
    <button
      type="button"
      disabled={busy}
      aria-busy={busy || undefined}
      onClick={() => {
        setBusy(true);
        void download(target).finally(() => setBusy(false));
      }}
      className="text-link underline decoration-ring/40 underline-offset-[3px] hover:decoration-current disabled:opacity-60"
    >
      {children}
    </button>
  );
}
