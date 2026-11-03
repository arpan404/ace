import { useClient } from "@ace/client-react";
import { ItemId, ThreadId } from "@ace/protocol";
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { DownloadError, saveDownload } from "@/lib/save-download.ts";
import { filePreviewTab, useOptionalWorkspace } from "@/lib/workspace/index.ts";
import type { PreviewFile } from "./attachment-format.ts";
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

/** Opens a linked file for prose on a thread's screen; provided by `ThreadLinkedFiles`. */
export const LinkedFileOpener = createContext<((target: LinkedFileTarget) => void) | undefined>(
  undefined,
);

/**
 * Shows a file the daemon holds (sent with a message, saved by an agent) in the thread's side
 * panel. False when it can't (a file only this browser has): the caller shows it its own way.
 */
export const PanelFileOpener = createContext<((file: PreviewFile) => boolean) | undefined>(
  undefined,
);

/**
 * On a thread's screen, files its messages link, carry or save open in its side panel, each by
 * its kind (PDF, video, audio, image, text). With no panel, a linked file downloads.
 */
export function ThreadLinkedFiles(props: { threadId: string; children: ReactNode }) {
  const download = useLinkedFileDownload();
  const workspace = useOptionalWorkspace(props.threadId);
  const openLinked = useCallback(
    (target: LinkedFileTarget) => {
      if (!workspace) return void download(target);
      workspace.actions.open(
        filePreviewTab({
          name: target.name,
          source: {
            kind: "link",
            threadId: target.threadId,
            itemId: target.itemId,
            reference: target.reference,
          },
        }),
      );
    },
    [download, workspace],
  );
  const openFile = useMemo(() => {
    if (!workspace) return undefined;
    return (file: PreviewFile) => {
      const source = file.source;
      if (!source || source.kind === "file") return false;
      workspace.actions.open(
        filePreviewTab({
          name: file.name,
          ...(file.mimeType ? { mimeType: file.mimeType } : {}),
          ...(file.kind ? { kind: file.kind } : {}),
          ...(file.bytes !== undefined ? { bytes: file.bytes } : {}),
          source,
        }),
      );
      return true;
    };
  }, [workspace]);
  return (
    <LinkedFileOpener value={openLinked}>
      <PanelFileOpener value={openFile}>{props.children}</PanelFileOpener>
    </LinkedFileOpener>
  );
}

/** A message's link to a file outside the thread's checkout: opens it beside the thread. */
export function LinkedFile(props: LinkedFileTarget & { children: ReactNode }) {
  const open = useContext(LinkedFileOpener);
  const download = useLinkedFileDownload();
  const [busy, setBusy] = useState(false);
  const { children, ...target } = props;
  return (
    <button
      type="button"
      disabled={busy}
      aria-busy={busy || undefined}
      onClick={() => {
        if (open) return open(target);
        setBusy(true);
        void download(target).finally(() => setBusy(false));
      }}
      className="text-link underline decoration-ring/40 underline-offset-[3px] hover:decoration-current disabled:opacity-60"
    >
      {children}
    </button>
  );
}
