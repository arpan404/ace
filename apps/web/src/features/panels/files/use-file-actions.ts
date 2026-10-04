import { useClient } from "@ace/client-react";
import { ThreadId } from "@ace/protocol";
import { isCheckoutPath, pathParts } from "@ace/ui-core";
import { useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { launchEditor } from "@/boot/editor-launch.ts";
import { useToast } from "@/components/ui/toast.tsx";
import { useEditors } from "@/lib/editors.ts";
import { checkoutError, fromCode, type CheckoutError } from "./checkout-source.ts";
import { useCheckoutSource } from "./use-checkout.ts";

/** A file going up to the checkout, as the tree's status line shows it. */
export type UploadState =
  | { phase: "sending"; name: string; path: string; sent: number; size: number }
  | { phase: "conflict"; name: string; path: string; file: File; version: string }
  | { phase: "failed"; name: string; path: string; error: CheckoutError };

/** Bytes as people say them: 940 B, 12 KB, 3.4 MB. */
export function formatBytes(bytes: number): string {
  if (bytes < 1000) return `${bytes} B`;
  if (bytes < 1_000_000) return `${Math.round(bytes / 1000)} KB`;
  return `${(bytes / 1_000_000).toFixed(bytes < 10_000_000 ? 1 : 0)} MB`;
}

/**
 * What a file tab does with files beyond showing them: save one to this device, send files up
 * to the checkout (never over a file that appeared or changed meanwhile unless the person says
 * so), copy its path, and open it in the editor on the daemon's machine at a line.
 */
export function useFileActions(threadId: string, onUploaded: (path: string) => void) {
  const source = useCheckoutSource();
  const client = useClient();
  const toast = useToast();
  const queries = useQueryClient();
  const { editors, current: editor, choose } = useEditors();
  const [saving, setSaving] = useState<{ path: string; received: number } | undefined>();
  const [upload, setUpload] = useState<UploadState | undefined>();
  const cancel = useRef<AbortController | undefined>(undefined);

  const save = async (path: string) => {
    if (saving) return;
    setSaving({ path, received: 0 });
    try {
      const blob = await source.download(threadId, path, (received) =>
        setSaving({ path, received }),
      );
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = pathParts(path).name;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch (error) {
      toast.add({ title: "Couldn't download the file", description: checkoutError(error).message });
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

  const openInEditor = async (path: string, line?: number, editorId = editor?.id) => {
    if (!editorId) return;
    try {
      const result = await client.command({
        type: "workspace.editor.open",
        threadId: ThreadId.parse(threadId),
        editorId,
      });
      if (!result.ok || !result.editor) throw new Error(result.error ?? "editor_failed");
      const root = result.editor.path.replace(/\/$/, "");
      await launchEditor({
        editorId: result.editor.editor.id,
        editorName: result.editor.editor.name,
        path: `${root}/${path}`,
        line,
      });
      choose(result.editor.editor.id);
    } catch (error) {
      toast.add({
        title: "Couldn't open the editor",
        description: error instanceof Error ? error.message : undefined,
      });
    }
  };

  const copyPath = (path: string) => {
    void navigator.clipboard?.writeText(path).then(
      () => toast.add({ title: "Path copied" }),
      () => toast.add({ title: "Couldn't copy. Select the path and copy it yourself." }),
    );
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
    editor,
    openInEditor,
    copyPath,
  };
}
