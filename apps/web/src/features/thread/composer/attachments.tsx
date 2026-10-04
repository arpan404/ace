import { FileIcon, WarningIcon, XIcon } from "@phosphor-icons/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { Spinner } from "@/components/ui/spinner.tsx";
import { Tip } from "@/components/ui/tooltip.tsx";
import { useThreadSources, type ThreadRef } from "../sources/index.ts";

export interface PendingAttachment {
  key: number;
  name: string;
  /** Object URL for image previews; a draft restored after a reload has none. */
  preview?: string | undefined;
  state: "uploading" | "ready" | "failed";
  progress: number;
  /** Set once the daemon holds the file. */
  sha256?: string | undefined;
  /** Why it failed, in words. */
  error?: string | undefined;
}

const maxBytes = 25 * 1024 * 1024;

/**
 * Files and images added to the next message, uploaded into the thread's context right away.
 * `restored` are uploads the daemon already holds, from a draft kept across a reload.
 */
export function useAttachments(
  thread: ThreadRef,
  restored: readonly { sha256: string; name: string }[] = [],
) {
  const sources = useThreadSources();
  const [items, setItems] = useState<PendingAttachment[]>(() =>
    restored.map((file, index) => ({
      key: -1 - index,
      name: file.name,
      state: "ready",
      progress: 1,
      sha256: file.sha256,
    })),
  );
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
          {
            key,
            name: file.name,
            preview,
            state: tooBig ? "failed" : "uploading",
            progress: 0,
            ...(tooBig ? { error: "Larger than 25 MB" } : {}),
          },
        ]);
        if (tooBig) continue;
        sources.context
          .upload(thread, file, (progress) => patch(key, { progress }))
          .then(
            (attachment) => patch(key, { state: "ready", sha256: attachment.sha256 }),
            (error: unknown) =>
              patch(key, {
                state: "failed",
                error: error instanceof Error ? error.message : "The upload failed",
              }),
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
  const ready = items.flatMap((item) =>
    item.state === "ready" && item.sha256 ? [{ sha256: item.sha256, name: item.name }] : [],
  );
  return {
    items,
    add,
    remove,
    clear,
    uploading: items.some((item) => item.state === "uploading"),
    ready,
  };
}

/**
 * The attachments of the message being written: one row of fixed height above the text, which
 * scrolls sideways rather than wrapping, so adding a file never moves the text's inset.
 */
export function AttachmentChips(props: {
  items: readonly PendingAttachment[];
  onRemove(key: number): void;
}) {
  if (!props.items.length) return null;
  return (
    <ul
      aria-label="Attachments"
      className="flex scroll-fade-x gap-2 overflow-x-auto px-3 pt-3 [scrollbar-width:none]"
    >
      {props.items.map((item) => (
        <li
          key={item.key}
          className="inline-flex h-8 max-w-60 shrink-0 items-center gap-1.5 rounded-lg bg-secondary pr-1 pl-1 text-[13px] leading-4"
        >
          {item.preview ? (
            <img src={item.preview} alt="" className="size-6 rounded-sm object-cover" />
          ) : (
            <span className="grid size-6 place-items-center">
              <FileIcon aria-hidden size={14} className="text-muted-foreground" />
            </span>
          )}
          <span className="min-w-0 truncate">{item.name}</span>
          {item.state === "uploading" && <Spinner label={`Uploading ${item.name}`} />}
          {item.state === "failed" && (
            <Tip label={item.error ?? "The upload failed"}>
              <WarningIcon
                role="img"
                aria-label={`${item.name} couldn't be attached: ${item.error ?? "the upload failed"}`}
                size={14}
                className="shrink-0 text-status-failed"
              />
            </Tip>
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
