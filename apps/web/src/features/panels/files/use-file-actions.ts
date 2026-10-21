import { useClient } from "@ace/client-react";
import { ThreadId } from "@ace/protocol";
import { isCheckoutPath, pathParts } from "@ace/ui-core";
import { useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { DownloadError, saveDownload } from "@/lib/save-download.ts";
import { useToast } from "@/components/ui/toast.tsx";
import { useCopy } from "@/components/use-copy.ts";
import { useOpenInEditor } from "@/lib/open-in-editor.ts";
import { checkoutError, fromCode, type CheckoutError } from "./checkout-source.ts";
import { useCheckoutSource } from "./use-checkout.ts";

/** A file going up to the checkout, as the tree's status line shows it. */
export type UploadState =
  | { phase: "sending"; name: string; path: string; sent: number; size: number }
  | { phase: "conflict"; name: string; path: string; file: File; version: string }
  | { phase: "failed"; name: string; path: string; error: CheckoutError };

export { formatBytes } from "@/components/format-bytes.ts";

/**
 * What a file tab does with files beyond showing them: save one to this device, send files up
 * to the checkout (never over a file that appeared or changed meanwhile unless the person says
 * so), copy its path, and open it in the editor on the daemon's machine at a line.
 */
export function useFileActions(threadId: string, onUploaded: (path: string) => void) {
  const source = useCheckoutSource();
  const client = useClient();
  const toast = useToast();
  const pathCopy = useCopy(() =>
    toast.error({ title: "Couldn't copy. Select the path and copy it yourself." }),
  );
  const queries = useQueryClient();
  const {
    editors,
    editor,
    unavailable: editorUnavailable,
    open: openInEditor,
  } = useOpenInEditor(threadId);
  const [saving, setSaving] = useState<{ path: string; received: number } | undefined>();
  const [upload, setUpload] = useState<UploadState | undefined>();
  const cancel = useRef<AbortController | undefined>(undefined);

  const save = async (path: string) => {
    if (saving) return;
    setSaving({ path, received: 0 });
    try {
      let received = 0;
      const chunks = client.downloadFile({
        threadId: ThreadId.parse(threadId),
        op: "download",
        path,
        offset: 0,
      });
      async function* progress() {
        for await (const chunk of chunks) {
          received += chunk.length;
          setSaving({ path, received });
          yield chunk;
        }
      }
      await saveDownload(pathParts(path).name, progress());
    } catch (error) {
      const failure = checkoutError(error);
      if (failure.code !== "aborted")
        toast.error({
          title: "Couldn't download the file",
          description: error instanceof DownloadError ? error.message : failure.message,
        });
    } finally {
      setSaving(undefined);
    }
  };

  const send = async (file: File, path: string, expected: string | null) => {
    const controller = new AbortController();
    cancel.current = controller;
    setUpload({ phase: "sending", name: file.name, path, sent: 0, size: file.size });
    try {
      await source.upload(
        threadId,
        path,
        file,
        expected,
        (sent) => setUpload({ phase: "sending", name: file.name, path, sent, size: file.size }),
        controller.signal,
      );
      setUpload(undefined);
      void queries.invalidateQueries({ queryKey: ["checkout"] });
      onUploaded(path);
      return true;
    } catch (error) {
      const failure = checkoutError(error);
      if (failure.code === "aborted" || controller.signal.aborted) setUpload(undefined);
      else setUpload({ phase: "failed", name: file.name, path, error: failure });
      return false;
    } finally {
      if (cancel.current === controller) cancel.current = undefined;
    }
  };

  /** Send each file into `folder` ("" is the checkout's root), one after another. */
  const uploadFiles = async (files: readonly File[], folder: string) => {
    for (const file of files) {
      const path = `${folder}${file.name}`;
      if (!isCheckoutPath(path)) {
        setUpload({
          phase: "failed",
          name: file.name,
          path,
          error: fromCode("OUTSIDE_WORKSPACE"),
        });
        return;
      }
      let version: string | null;
      try {
        version = (await source.stat(threadId, path)).version;
      } catch (error) {
        setUpload({ phase: "failed", name: file.name, path, error: checkoutError(error) });
        return;
      }
      // Something is already there: ask before replacing it.
      if (version !== null) {
        setUpload({ phase: "conflict", name: file.name, path, file, version });
        return;
      }
      if (!(await send(file, path, null))) return;
    }
  };

  return {
    saving,
    save,
    upload,
    uploadFiles,
    /** Replace the file a conflict stopped at (the person confirmed). */
    replace: () => {
      if (upload?.phase === "conflict") void send(upload.file, upload.path, upload.version);
    },
    dismissUpload: () => {
      cancel.current?.abort();
      setUpload(undefined);
    },
    editors,
    editorUnavailable,
    editor,
    openInEditor,
    copyPath: pathCopy.copy,
    /** A path was just copied: Copy path shows a check for a moment. */
    pathCopied: pathCopy.copied,
  };
}
