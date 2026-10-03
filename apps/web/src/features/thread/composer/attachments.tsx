import type { Attachment } from "@ace/protocol";
import { FileIcon, WarningIcon, XIcon } from "@phosphor-icons/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { Spinner } from "@/components/ui/spinner.tsx";
import { useThreadSources, type ThreadRef } from "../sources/index.ts";

export interface PendingAttachment {
  key: number;
  name: string;
  /** Object URL for image previews. */
  preview?: string | undefined;
  state: "uploading" | "ready" | "failed";
  progress: number;
  attachment?: Attachment | undefined;
}

const maxBytes = 25 * 1024 * 1024;

/** Files and images added to the next message, uploaded into the thread's context right away. */
export function useAttachments(thread: ThreadRef) {
  const sources = useThreadSources();
  const [items, setItems] = useState<PendingAttachment[]>([]);
  const next = useRef(0);
  const previews = useRef(new Set<string>());
  useEffect(() => {
    const urls = previews.current;
    return () => {
      for (const url of urls) URL.revokeObjectURL(url);
    };
  }, []);
  const add = useCallback(
    (files: Iterable<File>) => {
      const patch = (key: number, change: Partial<PendingAttachment>) =>
        setItems((list) => list.map((item) => (item.key === key ? { ...item, ...change } : item)));
      for (const file of files) {
        const key = ++next.current;
        const preview =
          file.type.startsWith("image/") && typeof URL.createObjectURL === "function"
            ? URL.createObjectURL(file)
            : undefined;
        if (preview) previews.current.add(preview);
        const tooBig = file.size > maxBytes;
        setItems((list) => [
          ...list,
          { key, name: file.name, preview, state: tooBig ? "failed" : "uploading", progress: 0 },
        ]);
        if (tooBig) continue;
        sources.context
          .upload(thread, file, (progress) => patch(key, { progress }))
          .then(
            (attachment) => patch(key, { state: "ready", attachment }),
            () => patch(key, { state: "failed" }),
          );
      }
    },
    [sources, thread],
  );
  const remove = (key: number) =>
    setItems((list) => {
      const gone = list.find((item) => item.key === key);
      if (gone?.preview) {
        URL.revokeObjectURL(gone.preview);
        previews.current.delete(gone.preview);
      }
      return list.filter((item) => item.key !== key);
    });
  const clear = () => {
    for (const url of previews.current) URL.revokeObjectURL(url);
    previews.current.clear();
    setItems([]);
  };
  return {
    items,
    add,
    remove,
    clear,
    uploading: items.some((item) => item.state === "uploading"),
    ready: items.flatMap((item) => (item.attachment ? [{ sha256: item.attachment.sha256 }] : [])),
  };
}

/** Chips for the attachments of the message being written. */
export function AttachmentChips(props: {
  items: readonly PendingAttachment[];
  onRemove(key: number): void;
}) {
  if (!props.items.length) return null;
  return (
    <ul aria-label="Attachments" className="flex flex-wrap gap-1.5 px-2 pt-1.5">
      {props.items.map((item) => (
        <li
          key={item.key}
          className="inline-flex h-8 max-w-60 items-center gap-1.5 rounded-md bg-secondary pr-0.5 pl-1 text-sm"
        >
          {item.preview ? (
            <img src={item.preview} alt="" className="size-6 rounded-xs object-cover" />
          ) : (
            <FileIcon aria-hidden size={14} className="ml-1 text-muted-foreground" />
          )}
          <span className="min-w-0 truncate">{item.name}</span>
          {item.state === "uploading" && <Spinner label={`Uploading ${item.name}`} />}
          {item.state === "failed" && (
            <WarningIcon
              role="img"
              aria-label={`${item.name} couldn't be attached`}
              size={14}
              className="text-status-failed"
            />
          )}
          <IconButton
            icon={XIcon}
            label={`Remove ${item.name}`}
            size="sm"
            tooltip={false}
            onClick={() => props.onRemove(item.key)}
          />
        </li>
      ))}
    </ul>
  );
}
