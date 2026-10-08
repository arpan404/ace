import { useClient } from "@ace/client-react";
import { ThreadId } from "@ace/protocol";
import { DownloadSimpleIcon, ArrowSquareOutIcon } from "@phosphor-icons/react";
import { useState } from "react";
import {
  fileTab,
  fileTabId,
  useScopeWorkspace,
  useWorkspaceActions,
} from "@/lib/workspace/index.ts";
import { DownloadError, saveDownload } from "@/lib/save-download.ts";
import { IconButton } from "./ui/icon-button.tsx";
import { useToast } from "./ui/toast.tsx";

export function ArtifactActions(props: { threadId: string; path: string }) {
  const client = useClient();
  const workspace = useWorkspaceActions(props.threadId);
  const state = useScopeWorkspace(props.threadId);
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const download = async () => {
    setBusy(true);
    try {
      await saveDownload(
        props.path.split("/").at(-1) || "file",
        client.downloadFile({
          threadId: ThreadId.parse(props.threadId),
          op: "download",
          path: props.path,
          offset: 0,
        }),
      );
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") return;
      toast.error({
        title: "Couldn't download the saved file",
        description:
          error instanceof DownloadError
            ? error.message
            : "Check that it is still in the checkout, then try again.",
      });
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <IconButton
        icon={ArrowSquareOutIcon}
        label="Open saved file"
        className="size-7"
        onClick={() => {
          const existing = state.tabs.find(
            (tab) => tab.kind === "files" && tab.id === fileTabId(props.path),
          );
          if (existing) workspace.activate(existing.key);
          else workspace.open(fileTab(props.path));
        }}
      />
      <IconButton
        icon={DownloadSimpleIcon}
        label="Download saved file"
        className="size-7"
        disabled={busy}
        onClick={() => void download()}
      />
    </>
  );
}
