import { useClient } from "@ace/client-react";
import { ItemId, ThreadId } from "@ace/protocol";
import { useState, type ReactNode } from "react";
import { DownloadError, saveDownload } from "@/lib/save-download.ts";
import { useToast } from "./ui/toast.tsx";

/**
 * A message's link to a file outside the thread's checkout. The daemon serves it only because
 * this message links it, so it works from any device that can read the thread.
 */
export function LinkedFile(props: {
  threadId: string;
  itemId: string;
  reference: string;
  name: string;
  children: ReactNode;
}) {
  const client = useClient();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const download = async () => {
    setBusy(true);
    try {
      await saveDownload(
        props.name,
        client.downloadFile({
          threadId: ThreadId.parse(props.threadId),
          op: "link.download",
          itemId: ItemId.parse(props.itemId),
          reference: props.reference,
          offset: 0,
        }),
      );
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") return;
      toast.error({
        title: `Couldn't open ${props.name}`,
        description:
          error instanceof DownloadError
            ? error.message
            : "Check that the file is still there, then try again.",
      });
    } finally {
      setBusy(false);
    }
  };
  return (
    <button
      type="button"
      disabled={busy}
      aria-busy={busy || undefined}
      onClick={() => void download()}
      className="text-link underline decoration-ring/40 underline-offset-[3px] hover:decoration-current disabled:opacity-60"
    >
      {props.children}
    </button>
  );
}
