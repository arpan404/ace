import { ArrowSquareOutIcon, DownloadSimpleIcon, FolderOpenIcon } from "@ace/icons";
import type { SpadeDocumentRef } from "@ace/ui-core/spade-chat";
import { useState } from "react";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { useToast } from "@/components/ui/toast.tsx";
import { cn } from "@/lib/cn.ts";
import { spadeDocumentPath } from "./computer/document-reader.tsx";
import { saveAs } from "./save-as.ts";
import { useAttachmentActions } from "./spade-attachment-actions.ts";
import { useSpadeClient } from "./spade-machine.tsx";
import { spadeBlob } from "./spade-requests.ts";

/** Hands a stored document to the browser's downloads under its own name. */
export function useDownloadDocument(document: SpadeDocumentRef) {
  const client = useSpadeClient();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const download = async () => {
    setBusy(true);
    try {
      saveAs(await spadeBlob(client, spadeDocumentPath(document)), document.name);
    } catch (error) {
      toast.error({
        title: `Couldn't download ${document.name}`,
        description: error instanceof Error ? error.message : undefined,
      });
    } finally {
      setBusy(false);
    }
  };
  return { busy, download: () => void download() };
}

/** Open, Download and Show in Library as bare icons that appear on hover or focus. */
export function DocumentActions(props: { document: SpadeDocumentRef; className?: string }) {
  const { document } = props;
  const actions = useAttachmentActions();
  const { busy, download } = useDownloadDocument(document);
  return (
    <div
      className={cn(
        "flex shrink-0 items-center opacity-0 transition-opacity duration-(--motion-fast) group-focus-within/attachment:opacity-100 group-hover/attachment:opacity-100 pointer-coarse:opacity-100",
        props.className,
      )}
    >
      {actions.openDocument && (
        <IconButton
          icon={ArrowSquareOutIcon}
          label="Open"
          tip="Open in the panel"
          size="sm"
          onClick={() => actions.openDocument?.(document)}
        />
      )}
      <IconButton
        icon={DownloadSimpleIcon}
        label="Download"
        size="sm"
        disabled={busy}
        onClick={download}
      />
      {actions.showInLibrary && (
        <IconButton
          icon={FolderOpenIcon}
          label="Show in Library"
          size="sm"
          onClick={() => actions.showInLibrary?.(document)}
        />
      )}
    </div>
  );
}
